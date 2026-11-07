// The Pty and TreeProcess objects of the fallback: Node child processes, with v1's behaviour.

import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Signal } from '../protocol.ts';
import { DataFeed, ExitLatch, clampSize } from '../running.ts';
import type { ExitInfo, KillOptions, KillReport, Pty, TreeProcess } from '../types.ts';
import { parseNote } from './pty-helper.ts';

/** What the objects need from their host. */
export interface Killer {
  kill(rec: TreeRecord, opts: KillOptions | undefined): Promise<KillReport>;
  signal(rec: TreeRecord, sig: Signal, tree: boolean): void;
}

/** One started tree, as the host tracks it. `root` leads the process group. */
export interface TreeRecord {
  root: number;
  pid: number;
  latch: ExitLatch;
}

/** After the child exits, how long its output gets to drain (a background process may hold it). */
const DRAIN_MS = 300;

/** How a child ended, listened for from the moment it is spawned (so no exit is missed). */
export function exitOf(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

/** Finish `latch` once the child has exited and its output has ended (or DRAIN_MS has passed). */
function finishOnExit(exit: Promise<ExitInfo>, latch: ExitLatch, outputs: readonly Readable[], note: () => ExitInfo | null): void {
  const ended = Promise.all(outputs.map((s) => new Promise<void>((resolve) => (s.readableEnded || s.destroyed ? resolve() : s.once('close', () => resolve())))));
  void exit.then(async (info) => {
    let timer: NodeJS.Timeout | undefined;
    const drained = new Promise<void>((resolve) => (timer = setTimeout(resolve, DRAIN_MS)));
    await Promise.race([ended, drained]);
    clearTimeout(timer);
    latch.finish(note() ?? info);
  });
}

export class FallbackPty implements Pty {
  readonly latch = new ExitLatch();
  readonly exited = this.latch.exited;
  readonly rec: TreeRecord;
  readonly #feed = new DataFeed();
  readonly #child: ChildProcess;
  readonly #killer: Killer;
  readonly resizable: boolean;

  /** `ready` resolves with the program's pid once the helper reports it (the helper's own otherwise). */
  static start(child: ChildProcess, exit: Promise<ExitInfo>, helper: boolean, killer: Killer): Promise<FallbackPty> {
    const root = child.pid ?? 0;
    let note: ExitInfo | null = null;
    let reportPid: (pid: number) => void = () => {};
    const pid = new Promise<number>((resolve) => {
      reportPid = resolve;
      if (!helper) resolve(root);
      setTimeout(() => resolve(root), 3000).unref();
      void exit.then(() => resolve(root));
    });
    let ctl = '';
    child.stdio[3]?.on('data', (d: Buffer) => {
      ctl += d.toString('utf8');
      for (let nl = ctl.indexOf('\n'); nl >= 0; nl = ctl.indexOf('\n')) {
        const n = parseNote(ctl.slice(0, nl));
        ctl = ctl.slice(nl + 1);
        if (n && 'pid' in n) reportPid(n.pid);
        else if (n) note = n;
      }
    });
    child.stdio[3]?.on('error', () => {});
    const pty = (p: number) => new FallbackPty(child, exit, helper, killer, { root, pid: p }, () => note);
    return pid.then(pty);
  }

  private constructor(child: ChildProcess, exit: Promise<ExitInfo>, helper: boolean, killer: Killer, rec: Omit<TreeRecord, 'latch'>, note: () => ExitInfo | null) {
    this.#child = child;
    this.#killer = killer;
    this.resizable = helper;
    this.rec = { ...rec, latch: this.latch };
    child.stdout?.on('data', (d: Buffer) => this.#feed.push(d));
    // The helper's own complaints (it couldn't start the program) are shown on the terminal.
    child.stderr?.on('data', (d: Buffer) => this.#feed.push(Buffer.from(d.toString('utf8').replace(/\r?\n/g, '\r\n'))));
    child.stdin?.on('error', () => {});
    // fd 3 too: the helper's "exit" line must be read before the exit is reported.
    const outputs = [child.stdout, child.stderr, child.stdio[3]].filter((s): s is Readable => s !== null && s !== undefined && 'once' in s);
    finishOnExit(exit, this.latch, outputs, note);
  }

  get pid(): number {
    return this.rec.pid;
  }

  onData(fn: (chunk: Buffer) => void): () => void {
    return this.#feed.on(fn);
  }

  onExit(fn: (e: ExitInfo) => void): () => void {
    return this.latch.onExit(fn);
  }

  write(data: string | Uint8Array): void {
    if (!this.latch.done) this.#child.stdin?.write(data);
  }

  resize(cols: number, rows: number): boolean {
    if (!this.resizable || this.latch.done) return false;
    const ctl = this.#child.stdio[3];
    if (!ctl || !('write' in ctl)) return false;
    (ctl as Writable).write(`${clampSize(rows, 1)} ${clampSize(cols, 1)}\n`);
    return true;
  }

  signal(sig: Signal, opts?: { tree?: boolean }): void {
    this.#killer.signal(this.rec, sig, opts?.tree ?? false);
  }

  kill(opts?: KillOptions): Promise<KillReport> {
    return this.#killer.kill(this.rec, opts);
  }
}

export class FallbackTree implements TreeProcess {
  readonly latch = new ExitLatch();
  readonly exited = this.latch.exited;
  readonly rec: TreeRecord;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly #killer: Killer;

  constructor(child: ChildProcess, exit: Promise<ExitInfo>, killer: Killer) {
    const { stdin, stdout, stderr } = child;
    // spawn() with stdio 'pipe' always makes all three; their absence is a Node bug, not a case.
    if (!stdin || !stdout || !stderr) throw new Error('spawn gave no pipes');
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    stdin.on('error', () => {}); // EPIPE once it exits; the exit reports how
    this.#killer = killer;
    const pid = child.pid ?? 0;
    this.rec = { root: pid, pid, latch: this.latch };
    finishOnExit(exit, this.latch, [stdout, stderr], () => null);
  }

  get pid(): number {
    return this.rec.pid;
  }

  onExit(fn: (e: ExitInfo) => void): () => void {
    return this.latch.onExit(fn);
  }

  signal(sig: Signal, opts?: { tree?: boolean }): void {
    this.#killer.signal(this.rec, sig, opts?.tree ?? false);
  }

  kill(opts?: KillOptions): Promise<KillReport> {
    return this.#killer.kill(this.rec, opts);
  }
}
