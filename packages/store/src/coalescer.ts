// Write coalescing (plan §4.1, "write cadence"): token deltas and activity events arrive many times
// a second. Buffered here per entity, they commit once per harness step or every 250 ms at most, so
// a crash loses at most 250 ms of text (which the harness can replay) and the WAL stays small.

import type { PatchOp } from '@wisp/protocol';
import type { Disposable, EntityRef, Row, Writer } from './types.ts';

/** Who runs the 250 ms timer: a plugin passes its scope's, tests pass a fake one. */
export interface Scheduler {
  after(ms: number, fn: () => void): Disposable;
}

export const timerScheduler: Scheduler = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref(); // a pending flush never keeps the process alive; close() flushes
    return { dispose: () => clearTimeout(t) };
  },
};

export type Buffered = { kind: EntityRef; op: 'append'; rows: Row[] } | { kind: EntityRef; op: 'patch'; id: string | number; ops: PatchOp[] };

export interface CoalescerOptions {
  intervalMs?: number;
  scheduler?: Scheduler;
  /** a buffered write the store refused (its row was deleted meanwhile, …); the rest still commit */
  onError?: (err: unknown, item: Buffered) => void;
}

export class Coalescer implements Disposable {
  readonly #tx: <T>(fn: (w: Writer) => T) => T;
  readonly #interval: number;
  readonly #scheduler: Scheduler;
  readonly #onError: (err: unknown, item: Buffered) => void;
  readonly #items = new Map<string, Buffered>();
  #timer: Disposable | undefined;
  #disposed = false;

  constructor(store: { tx<T>(fn: (w: Writer) => T): T }, opts: CoalescerOptions = {}) {
    this.#tx = (fn) => store.tx(fn);
    this.#interval = opts.intervalMs ?? 250;
    this.#scheduler = opts.scheduler ?? timerScheduler;
    this.#onError = opts.onError ?? ((err) => console.error('[store] a coalesced write was refused', err));
  }

  /** entities with buffered writes */
  get size(): number {
    return this.#items.size;
  }

  append(kind: EntityRef, rows: readonly Row[]): void {
    if (rows.length === 0) return;
    const key = `a\0${nameOf(kind)}`;
    const had = this.#items.get(key);
    if (had?.op === 'append') had.rows.push(...rows);
    else this.#items.set(key, { kind, op: 'append', rows: [...rows] });
    this.#arm();
  }

  /** Ops for one row; later ops apply after earlier ones, and the change feed gets the net diff. */
  patch(kind: EntityRef, id: string | number, ops: readonly PatchOp[]): void {
    if (ops.length === 0) return;
    const key = `p\0${nameOf(kind)}\0${String(id)}`;
    const had = this.#items.get(key);
    if (had?.op === 'patch') had.ops.push(...ops);
    else this.#items.set(key, { kind, op: 'patch', id, ops: [...ops] });
    this.#arm();
  }

  /** The end of a harness step: commit what is buffered now. */
  step(): void {
    this.flush();
  }

  flush(): void {
    this.#timer?.dispose();
    this.#timer = undefined;
    if (this.#items.size === 0) return;
    const batch = [...this.#items.values()];
    this.#items.clear();
    try {
      this.#tx((w) => {
        for (const item of batch) write(w, item);
      });
    } catch {
      // One refused write must not drop the others: commit each on its own, and report the bad ones.
      for (const item of batch) {
        try {
          this.#tx((w) => write(w, item));
        } catch (err) {
          this.#onError(err, item);
        }
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.flush();
    this.#disposed = true;
  }

  #arm(): void {
    if (this.#disposed) throw new Error('this coalescer was disposed');
    this.#timer ??= this.#scheduler.after(this.#interval, () => {
      this.#timer = undefined;
      this.flush();
    });
  }
}

function write(w: Writer, item: Buffered): void {
  if (item.op === 'append') w.append(item.kind, item.rows);
  else w.patch(item.kind, item.id, item.ops);
}

function nameOf(kind: EntityRef): string {
  return typeof kind === 'string' ? kind : kind.kind;
}
