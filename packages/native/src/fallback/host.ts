// The NativeHost without wisp-native: the same API on Node child processes, so an install never
// breaks (plan §7.1). PTYs come from the Python helper or script(1) (Unix only, as in v1); trees
// are process groups on Unix and taskkill /T on Windows.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NativeError } from '../errors.ts';
import type { ListItem, Signal } from '../protocol.ts';
import { findExecutable, resolveCommand } from '../resolve-command.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, GONE_KEPT, clampSize, graceOf } from '../running.ts';
import type { HostInfo, KillOptions, KillReport, NativeHost, Pty, SpawnOptions, SpawnPtyOptions, TreeProcess } from '../types.ts';
import { FallbackPty, FallbackTree, type Killer, type TreeRecord, exitOf } from './procs.ts';
import { ptyCommand, python } from './pty-helper.ts';
import { killGroupsNow, killTreeUnix, killTreeWindows, signalTreeUnix } from './tree.ts';

export interface FallbackStart {
  reason: string;
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

type Entry = { rec: TreeRecord; pty: boolean; id: string };

export function startFallback(opts: FallbackStart): NativeHost {
  return new FallbackHost(opts);
}

class FallbackHost implements NativeHost, Killer {
  readonly info: HostInfo;
  readonly #platform: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #entries = new Map<number, Entry>();
  #seq = 0;
  #closed = false;
  /** Detached children outlive us unless killed: on the way out, kill them. */
  readonly #sweep = (): void => killGroupsNow([...this.#entries.values()].filter((e) => !e.rec.latch.done).map((e) => e.rec.root));

  constructor(opts: FallbackStart) {
    this.#platform = opts.platform ?? process.platform;
    this.#env = opts.env ?? process.env;
    this.info = { kind: 'fallback', reason: opts.reason };
    process.on('exit', this.#sweep);
  }

  #check(opts: SpawnOptions): void {
    if (this.#closed) throw new NativeError('io', 'this native host is closed');
    if (opts.cwd !== undefined && !isDir(opts.cwd)) throw new NativeError('spawn_failed', `couldn't start ${opts.cmd}: no such folder: ${opts.cwd}`);
    const env = opts.env ?? this.#env;
    const bin = opts.cmd.includes('/') && opts.cwd ? path.resolve(opts.cwd, opts.cmd) : opts.cmd;
    if (!findExecutable(bin, env, this.#platform)) throw new NativeError('spawn_failed', `couldn't start ${opts.cmd}: not found`);
  }

  async spawnPty(opts: SpawnPtyOptions): Promise<Pty> {
    if (this.#platform === 'win32') throw new NativeError('unsupported', 'a terminal needs wisp-native on Windows');
    this.#check(opts);
    // The helper is found on the server's PATH (absolute), not the program's: env may have none.
    const py = python({ platform: this.#platform, env: this.#env });
    const pyBin = py && (findExecutable(py, this.#env, this.#platform) ?? py);
    const plan = ptyCommand([opts.cmd, ...(opts.args ?? [])], { cols: clampSize(opts.cols, DEFAULT_COLS), rows: clampSize(opts.rows, DEFAULT_ROWS), platform: this.#platform, py: pyBin });
    if (!plan.helper) plan.command = findExecutable(plan.command, this.#env, this.#platform) ?? plan.command;
    const child = await started(spawn(plan.command, plan.args, { ...where(opts), stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true }), opts.cmd);
    const pty = await FallbackPty.start(child, exitOf(child), plan.helper, this);
    this.#track(pty.rec, true);
    return pty;
  }

  async spawnTree(opts: SpawnOptions): Promise<TreeProcess> {
    this.#check(opts);
    const win = this.#platform === 'win32';
    const r = resolveCommand(opts.cmd, opts.args ?? [], { platform: this.#platform, env: opts.env ?? this.#env });
    // detached on Unix: the child leads a new process group, so kill(-pid) reaches its tree.
    const child = spawn(r.command, r.args, { ...where(opts), stdio: 'pipe', detached: !win, windowsHide: true, windowsVerbatimArguments: r.verbatim });
    const exit = exitOf(child);
    const tree = new FallbackTree(await started(child, opts.cmd), exit, this);
    this.#track(tree.rec, false);
    return tree;
  }

  #track(rec: TreeRecord, pty: boolean): void {
    this.#seq += 1;
    this.#entries.set(rec.root, { rec, pty, id: `f${this.#seq}` });
    // Keep the newest exited ones (what they left behind stays killable), like the binary.
    const gone = [...this.#entries.values()].filter((e) => e.rec.latch.done);
    for (const e of gone.slice(0, Math.max(0, gone.length - GONE_KEPT))) this.#entries.delete(e.rec.root);
  }

  kill(rec: TreeRecord, opts: KillOptions | undefined): Promise<KillReport> {
    const alive = !rec.latch.done;
    if (this.#platform === 'win32') return Promise.resolve(killTreeWindows(rec.root, alive));
    return killTreeUnix(rec.root, alive, opts?.signal ?? 'SIGTERM', graceOf(opts?.graceMs));
  }

  signal(rec: TreeRecord, sig: Signal, tree: boolean): void {
    const alive = !rec.latch.done;
    if (this.#platform === 'win32') {
      if (sig === 'SIGKILL' || sig === 'SIGTERM' || sig === 'SIGHUP') killTreeWindows(rec.root, alive);
      return;
    }
    if (tree) void signalTreeUnix(rec.root, alive, sig);
    else if (alive) {
      try {
        process.kill(rec.pid, sig);
      } catch {}
    }
  }

  killTree(pid: number, opts?: KillOptions): Promise<KillReport> {
    const e = this.#entries.get(pid) ?? [...this.#entries.values()].find((x) => x.rec.pid === pid);
    if (!e) return Promise.reject(new NativeError('unknown_id', `no process ${pid} was started here`));
    return this.kill(e.rec, opts);
  }

  list(): Promise<ListItem[]> {
    const items = [...this.#entries.values()].map((e) => ({ id: e.id, pid: e.rec.pid, pty: e.pty, exited: e.rec.latch.done }));
    return Promise.resolve(items.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    process.off('exit', this.#sweep);
    const all = [...this.#entries.values()];
    await Promise.all(all.map((e) => this.kill(e.rec, { graceMs: 500 })));
    this.#entries.clear();
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function where(opts: SpawnOptions): { cwd?: string; env?: NodeJS.ProcessEnv } {
  return { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: { ...opts.env } } : {}) };
}

/** Resolves once the OS has started it; a spawn error (ENOENT, EACCES) rejects as spawn_failed. */
function started(child: ChildProcess, cmd: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', (e) => reject(new NativeError('spawn_failed', `couldn't start ${cmd}: ${e.message}`)));
  });
}
