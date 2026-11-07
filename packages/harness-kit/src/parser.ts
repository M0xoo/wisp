// The shape every harness stream parser has (plan §3.1 rule 3: sans-IO). A parser is a machine fed
// one stdout line at a time, and the process's exit once; it answers with the events to report, in
// order. It never reads a file, a clock or a socket: the time comes in as `now`, and where a harness
// needs the disk (the file as it was before a write, a session file with its usage windows) the
// parser returns an `IoStep` in the event list, which the driver runs in place, keeping the order.
// Fixtures can then test a parser byte for byte, and the driver (drive.ts) is the only IO.

import type { FileTracker } from './tracker.ts';

/** How the process ended (v1 spawnJsonl's onClose argument). */
export interface Exit {
  code: number | null;
  signal: string | null;
  /** its last 8000 characters of stderr, trimmed */
  stderr: string;
  /** killed by stop() or a signal */
  stopped: boolean;
  /** killed by stop() only */
  stopRequested: boolean;
}

/** What a parser may ask the driver to do. Tests pass a fake. */
export interface HarnessIo {
  /** the file now: null when it isn't a file, '' when it is over MAX_SNAPSHOT */
  snapshot(abs: string): Promise<string | null>;
  /** the file now when it is at most `max` bytes, else null (missing, not a file, too big) */
  readUpTo(abs: string, max: number): Promise<string | null>;
  /** the run's tracker, for harnesses that only hear "file X changed" */
  readonly files: FileTracker;
}

/** A piece of IO the driver runs where it stands in the list; its events take its place. */
export interface IoStep<E> {
  readonly io: (io: HarnessIo) => Promise<readonly E[]>;
}

export type Out<E> = E | IoStep<E>;

export const ioStep = <E>(io: (io: HarnessIo) => Promise<readonly E[]>): IoStep<E> => ({ io });

export function isIo<E>(o: Out<E>): o is IoStep<E> {
  return typeof (o as { io?: unknown }).io === 'function';
}

export interface LineParser<E> {
  /** one stdout line: parsed JSON for stream-json CLIs (blank and non-JSON lines never arrive), else the text */
  line(msg: unknown, now: number): Out<E>[];
  /** stderr as it comes, for CLIs that only report trouble there */
  stderr?(text: string, now: number): Out<E>[];
  /** the process ended: the parser emits the final `result` if the stream didn't */
  close(exit: Exit, now: number): Out<E>[];
}

/**
 * Runs a parser over recorded lines with a given IO: what a golden test and the bench do. Lines are
 * raw stdout lines; JSON ones are parsed as the driver would.
 */
export async function replay<E>(parser: LineParser<E>, lines: readonly string[], exit: Exit, io: HarnessIo, o: { raw?: boolean; now?: (i: number) => number } = {}): Promise<E[]> {
  const out: E[] = [];
  const take = async (outs: Out<E>[]): Promise<void> => {
    for (const x of outs) {
      if (isIo(x)) out.push(...(await x.io(io)));
      else out.push(x);
    }
  };
  const now = o.now ?? ((i: number) => i);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (o.raw) await take(parser.line(line, now(i)));
    else if (line.trim()) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      await take(parser.line(msg, now(i)));
    }
  }
  await take(parser.close(exit, now(lines.length)));
  return out;
}

/** v1's exit for a CLI that finished on its own. */
export const cleanExit: Exit = { code: 0, signal: null, stderr: '', stopped: false, stopRequested: false };
