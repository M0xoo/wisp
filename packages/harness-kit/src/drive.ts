// The one IO side of a harness run (v1 adapters/common.js spawnJsonl): spawn the CLI through the
// proc service, feed its stdout to the parser line by line, run the parser's IO steps in order, and
// hand every event to onEvent. Events with no IO in front of them go out synchronously, in the same
// tick as their line: the hot path makes no promise per line.

import { realpath } from 'node:fs/promises';
import type { Child, ProcService } from '@wisp/kernel';
import { jsonLine, LineSplitter } from './lines.ts';
import { isIo, type Exit, type HarnessIo, type LineParser, type Out } from './parser.ts';
import type { RunPaths } from './paths.ts';
import { fileTracker, readSnapshot, readUpTo } from './tracker.ts';

export interface DriveOptions<E> {
  proc: ProcService;
  bin: string;
  args: readonly string[];
  cwd: string;
  /** the run's whole environment; PWD is set to cwd (opencode reads its folder from $PWD) */
  env: Record<string, string | undefined>;
  /** written to stdin, which is then closed (v1 wrote '' when there was nothing) */
  input?: string;
  /** made once the folder's real path is known */
  parser: (paths: RunPaths) => LineParser<E>;
  onEvent(e: E): void;
  /** the result of a run whose CLI could not start: v1 "Could not start `bin`: …" */
  failed(text: string): E;
  /** plain-text stdout: every line goes to the parser as a string */
  raw?: boolean;
  /** pin the folder's git state before the CLI starts writing (FileTracker's base) */
  track?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  /** after the process ended and every event went out (a temp file to remove) */
  cleanup?: () => Promise<void> | void;
}

export interface DriveHandle {
  stop(): void;
  readonly done: Promise<void>;
  /** the root of the run's process tree, once it started */
  readonly pid: number | undefined;
}

const STDERR_KEEP = 8000;

/** Emits outputs in order: synchronously until an IO step, then one step at a time. */
class Pump<E> {
  readonly #emit: (e: E) => void;
  readonly #io: () => HarnessIo;
  #queue: Out<E>[] = [];
  #at = 0;
  #busy: Promise<void> | null = null;

  constructor(emit: (e: E) => void, io: () => HarnessIo) {
    this.#emit = emit;
    this.#io = io;
  }

  push(outs: readonly Out<E>[]): void {
    if (this.#busy) {
      this.#queue.push(...outs);
      return;
    }
    for (let i = 0; i < outs.length; i++) {
      const o = outs[i] as Out<E>; // i < length
      if (!isIo(o)) {
        this.#emit(o);
        continue;
      }
      this.#queue = outs.slice(i);
      this.#busy = this.#drain();
      return;
    }
  }

  async #drain(): Promise<void> {
    while (this.#at < this.#queue.length) {
      const o = this.#queue[this.#at++] as Out<E>; // #at < length
      if (!isIo(o)) {
        this.#emit(o);
        continue;
      }
      let events: readonly E[] = [];
      try {
        events = await o.io(this.#io());
      } catch {
        // A read that failed reports nothing; the stream goes on, as v1's try/catch did.
      }
      for (const e of events) this.#emit(e);
    }
    this.#queue = [];
    this.#at = 0;
    this.#busy = null;
  }

  idle(): Promise<void> {
    return this.#busy ?? Promise.resolve();
  }
}

/**
 * Runs a CLI. `prepare` may be async (a config file to read, a temp file to write before the CLI
 * starts): the handle is returned at once either way, and a stop() before the CLI started means it
 * never starts.
 */
export function drive<E>(prepare: DriveOptions<E> | (() => Promise<DriveOptions<E>>), early?: Pick<DriveOptions<E>, 'onEvent' | 'failed'>): DriveHandle {
  let child: Child | undefined;
  let stopping = false;
  let io: HarnessIo | undefined;
  let signal: AbortSignal | undefined;
  const stop = (): void => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  const done = (async (): Promise<void> => {
    let o: DriveOptions<E>;
    try {
      o = typeof prepare === 'function' ? await prepare() : prepare;
    } catch (err) {
      // Nothing started: the run reports why, as a spawn failure would.
      if (early) early.onEvent(early.failed(err instanceof Error ? err.message : String(err)));
      return;
    }
    const now = o.now ?? Date.now;
    signal = o.signal;
    if (signal?.aborted) stopping = true;
    else signal?.addEventListener('abort', stop, { once: true });
    const pump = new Pump<E>(o.onEvent, () => {
      if (!io) throw new Error('harness IO before the run started'); // unreachable: io is set before any line
      return io;
    });
    const real = await realpath(o.cwd).catch(() => o.cwd);
    const paths: RunPaths = { cwd: o.cwd, real };
    io = { snapshot: readSnapshot, readUpTo, files: await fileTracker(o.proc, paths, !!o.track) };
    const parser = o.parser(paths);
    const exit = stopping ? stoppedBeforeStart() : await run(o, parser, pump, now, (c) => (child = c), () => stopping);
    if (exit) pump.push(parser.close(exit, now()));
    await pump.idle();
    signal?.removeEventListener('abort', stop);
    await o.cleanup?.();
  })();
  return {
    stop,
    done,
    get pid() {
      return child?.pid;
    },
  };
}

const stoppedBeforeStart = (): Exit => ({ code: null, signal: 'SIGTERM', stderr: '', stopped: true, stopRequested: true });

/** Spawns and reads the CLI; null when it never started (the failure was reported). */
async function run<E>(o: DriveOptions<E>, parser: LineParser<E>, pump: Pump<E>, now: () => number, started: (c: Child) => void, stopping: () => boolean): Promise<Exit | null> {
  let child: Child;
  try {
    child = o.proc.spawn(o.bin, o.args, { cwd: o.cwd, env: { ...o.env, PWD: o.cwd }, stdin: 'pipe', tree: true });
  } catch (err) {
    pump.push([o.failed(`Could not start \`${o.bin}\`: ${err instanceof Error ? err.message : String(err)}`)]);
    return null;
  }
  started(child);
  if (stopping()) child.kill('SIGTERM');
  const lines = new LineSplitter();
  let sawOutput = false;
  const feed = (line: string): void => {
    if (o.raw) return pump.push(parser.line(line, now()));
    const msg = jsonLine(line);
    if (msg !== undefined) pump.push(parser.line(msg, now()));
  };
  const outSub = child.onStdout((chunk) => {
    sawOutput = true;
    for (const line of lines.push(chunk)) feed(line);
  });
  const errDecoder = new TextDecoder();
  let stderr = '';
  const errSub = child.onStderr((chunk) => {
    const text = errDecoder.decode(chunk, { stream: true });
    stderr = (stderr + text).slice(-STDERR_KEEP);
    if (parser.stderr) pump.push(parser.stderr(text, now()));
  });
  try {
    child.write(o.input ?? '');
    child.closeStdin();
  } catch {
    // The CLI may exit before reading stdin.
  }
  let ended: { code: number | null; signal: string | null };
  try {
    ended = await child.exited;
  } catch (err) {
    outSub.dispose();
    errSub.dispose();
    pump.push([o.failed(`Could not start \`${o.bin}\`: ${err instanceof Error ? err.message : String(err)}`)]);
    return null;
  }
  for (const line of lines.end()) feed(line);
  outSub.dispose();
  errSub.dispose();
  const stop = stopping();
  // The proc service reports a program it couldn't start as an exit with neither code nor signal.
  // Only then is PATH looked through, to say so as v1 did ("Could not start `claude`: …").
  if (ended.code === null && ended.signal === null && !stop && !sawOutput && !(await o.proc.which(o.bin, o.env).catch(() => null))) {
    pump.push([o.failed(`Could not start \`${o.bin}\`: spawn ${o.bin} ENOENT`)]);
    return null;
  }
  // Windows reports a taskkill'd child as an exit code, not a signal: stopRequested says it.
  return { code: ended.code, signal: ended.signal, stderr: stderr.trim(), stopped: stop || ended.signal === 'SIGTERM' || ended.signal === 'SIGINT', stopRequested: stop };
}
