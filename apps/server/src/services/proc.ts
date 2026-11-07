// The kernel's `proc` service (plan §6.1, ADR-0009): every child process wisp starts, on @wisp/native.
// PTYs (`pty: {cols, rows}`) and process trees come from wisp-native, or its fallback (v1's Python
// pty.fork helper, process groups, taskkill /T), so killing a child kills everything it started.
// Windows .cmd shims are unwrapped the way v1's proc.js did (native's resolveCommand) so arguments
// wisp passes (JSON, newlines) arrive byte for byte.
//
// Native spawns asynchronously while the kernel's Child is synchronous: the Child this returns
// buffers writes, a stdin close and a kill until the process is up, and its pid reads 0 until then.
//
//   const proc = await createProc();              // one per server
//   ctx.service('proc') → proc.forScope(scope)    // per plugin: its trees die with its scope

import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Child, Disposable, ExecResult, ProcService, Scope, SpawnOptions } from '@wisp/kernel';
import { escapeCmdArgument, escapeCmdCommand, type NativeHost, type Pty, type Signal, startNative, type TreeProcess } from '@wisp/native';

export { escapeCmdArgument, escapeCmdCommand };

/** Beyond the kernel's SpawnOptions: a terminal app is started detached, on its own, never killed with wisp. */
export interface ProcSpawnOptions extends SpawnOptions {
  detached?: boolean;
  /** Windows, detached only: pass args as written (already quoted for cmd.exe) */
  verbatim?: boolean;
}

type Env = Record<string, string | undefined>;
type Exit = { code: number | null; signal: string | null };
type Fn = (chunk: Uint8Array) => void;

export const KILL_GRACE_MS = 2000; // SIGTERM (or SIGHUP), then SIGKILL for what is left
const MAX_EXEC = 32 * 1024 * 1024;

const cleanEnv = (env: Env | undefined): Record<string, string> | undefined => {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
};

/** A Child over a process that is still starting. */
class LateChild implements Child {
  #pid = 0;
  #p: Pty | TreeProcess | null = null;
  #queue: (string | Uint8Array)[] = [];
  #eof = false;
  #kill: (() => void) | null = null;
  #size: [number, number] | null = null;
  readonly #out = new Set<Fn>();
  readonly #err = new Set<Fn>();
  readonly exited: Promise<Exit>;

  constructor(start: Promise<Pty | TreeProcess>, onUp: (p: Pty | TreeProcess) => void) {
    this.exited = start.then((p) => {
      this.#up(p);
      onUp(p);
      return p.exited;
    });
  }

  get pid(): number {
    return this.#pid;
  }

  #up(p: Pty | TreeProcess): void {
    this.#p = p;
    this.#pid = p.pid;
    if ('onData' in p) p.onData((c) => this.#out.forEach((f) => f(c)));
    else {
      p.stdout.on('data', (c: Uint8Array) => this.#out.forEach((f) => f(c)));
      p.stderr.on('data', (c: Uint8Array) => this.#err.forEach((f) => f(c)));
      p.stdin.on('error', () => {}); // a child that exits while we write: its exit says so
    }
    for (const d of this.#queue.splice(0)) this.write(d);
    if (this.#size) this.resize(...this.#size);
    if (this.#eof) this.closeStdin();
    this.#kill?.();
  }

  onStdout(fn: Fn): Disposable {
    this.#out.add(fn);
    return { dispose: () => void this.#out.delete(fn) };
  }
  onStderr(fn: Fn): Disposable {
    this.#err.add(fn);
    return { dispose: () => void this.#err.delete(fn) };
  }
  write(data: string | Uint8Array): void {
    const p = this.#p;
    if (!p) return void this.#queue.push(data);
    if ('onData' in p) p.write(data);
    else p.stdin.write(data);
  }
  closeStdin(): void {
    const p = this.#p;
    this.#eof = true;
    if (!p) return;
    if ('onData' in p) p.write('\x04'); // a terminal's end of input is ^D
    else p.stdin.end();
  }
  resize(cols: number, rows: number): void {
    const p = this.#p;
    if (!p) return void (this.#size = [cols, rows]);
    if ('onData' in p) p.resize(cols, rows);
  }
  /** SIGINT is a key press (^C) for the tree; anything else ends the whole tree, SIGKILL after the grace. */
  kill(signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' = 'SIGTERM'): void {
    const go = (): void => {
      const p = this.#p;
      if (!p) return;
      if (signal === 'SIGINT') p.signal('SIGINT', { tree: true });
      else void p.kill({ signal: signal as Signal, graceMs: signal === 'SIGKILL' ? 0 : KILL_GRACE_MS }).catch(() => {});
    };
    if (this.#p) go();
    else this.#kill = go;
  }
}

/** A detached program (a terminal app): its own session, nothing kept, never killed with wisp. */
function detachedChild(bin: string, args: readonly string[], o: ProcSpawnOptions): Child {
  const cp = nodeSpawn(bin, [...args], { cwd: o.cwd, env: cleanEnv(o.env) ?? process.env, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: o.verbatim === true });
  const exited = new Promise<Exit>((resolve, reject) => {
    cp.once('error', reject);
    cp.once('exit', (code, signal) => resolve({ code, signal }));
  });
  cp.unref();
  const none: Disposable = { dispose: () => {} };
  return { pid: cp.pid ?? 0, onStdout: () => none, onStderr: () => none, write: () => {}, closeStdin: () => {}, resize: () => {}, kill: (s) => void cp.kill(s), exited };
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false);
const isExe = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false);

/** `bin` on PATH, as cmd.exe finds it on Windows (PATHEXT, then a .ps1 some installers drop). */
export async function which(bin: string, env: Env = process.env, platform: string = process.platform): Promise<string | null> {
  if (platform !== 'win32') {
    if (bin.includes('/')) return (await isExe(bin)) ? bin : null;
    for (const dir of String(env['PATH'] ?? '').split(':').filter(Boolean)) if (await isExe(path.join(dir, bin))) return path.join(dir, bin);
    return null;
  }
  const p = path.win32;
  const exts = String(env['PATHEXT'] ?? env['Pathext'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const names = p.extname(bin) ? [bin] : [...exts.map((e) => bin + e), `${bin}.ps1`];
  const dirs = /[\\/]/.test(bin) ? [''] : String(env['PATH'] ?? env['Path'] ?? '').split(';').filter(Boolean);
  for (const dir of dirs) for (const name of names) if (await isFile(dir ? p.join(dir, name) : name)) return dir ? p.join(dir, name) : name;
  return null;
}

export interface ProcHandle extends ProcService {
  spawn(bin: string, args: readonly string[], opts?: ProcSpawnOptions): Child;
  /** the same service, whose trees end when `scope` does */
  forScope(scope: Pick<Scope, 'signal' | 'add'>): ProcService;
  /** processes started and not yet exited */
  live(): number;
  readonly host: NativeHost;
  /** kill every tree, then stop the native helper */
  close(): Promise<void>;
}

export async function createProc(o: { host?: NativeHost; platform?: string } = {}): Promise<ProcHandle> {
  const host = o.host ?? (await startNative());
  const platform = o.platform ?? process.platform;
  const live = new Set<Child>();

  const spawn = (bin: string, args: readonly string[], opts: ProcSpawnOptions = {}, scope?: Pick<Scope, 'signal' | 'add'>): Child => {
    if (opts.detached) return detachedChild(bin, args, opts);
    const env = cleanEnv(opts.env);
    const base = { cmd: bin, args, ...(opts.cwd && { cwd: opts.cwd }), ...(env && { env }) };
    const start: Promise<Pty | TreeProcess> = opts.pty ? host.spawnPty({ ...base, cols: opts.pty.cols, rows: opts.pty.rows }) : host.spawnTree(base);
    const child = new LateChild(start, (p) => {
      if (opts.stdin === 'ignore' && !('onData' in p)) p.stdin.end();
    });
    live.add(child);
    const stops: (() => void)[] = [];
    const end = (): void => child.kill('SIGTERM');
    if (opts.timeoutMs) {
      const t = setTimeout(end, opts.timeoutMs);
      t.unref();
      stops.push(() => clearTimeout(t));
    }
    for (const signal of [opts.signal, opts.tree !== false ? scope?.signal : undefined]) {
      if (!signal) continue;
      if (signal.aborted) end();
      else (signal.addEventListener('abort', end, { once: true }), stops.push(() => signal.removeEventListener('abort', end)));
    }
    const done = (): void => (live.delete(child), stops.forEach((s) => s()));
    child.exited.then(done, done);
    return child;
  };

  const exec = async (bin: string, args: readonly string[], opts: SpawnOptions & { input?: string; maxBuffer?: number } = {}, scope?: Pick<Scope, 'signal' | 'add'>): Promise<ExecResult> => {
    const max = opts.maxBuffer ?? MAX_EXEC;
    let timedOut = false;
    const { timeoutMs, ...rest } = opts;
    const child = spawn(bin, args, rest, scope);
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let size = 0;
    const keep = (to: Uint8Array[]) => (c: Uint8Array): void => {
      if (size < max) to.push(size + c.length > max ? c.subarray(0, max - size) : c);
      size += c.length;
    };
    child.onStdout(keep(out));
    child.onStderr(keep(err));
    if (opts.input !== undefined) child.write(opts.input);
    child.closeStdin();
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), timeoutMs) : undefined;
    try {
      const { code } = await child.exited;
      return { code: timedOut ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut };
    } finally {
      clearTimeout(timer);
    }
  };

  const bound = (scope?: Pick<Scope, 'signal' | 'add'>): ProcService => ({
    which: (bin, env) => which(bin, env ?? process.env, platform),
    spawn: (bin, args, opts) => spawn(bin, args, opts, scope),
    exec: (bin, args, opts) => exec(bin, args, opts, scope),
  });

  return {
    ...bound(),
    forScope: (scope) => bound(scope),
    live: () => live.size,
    host,
    close: async () => {
      for (const c of live) c.kill('SIGKILL');
      await host.close();
    },
  };
}
