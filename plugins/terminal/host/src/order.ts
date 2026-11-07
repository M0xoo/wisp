// Numbered input (v1 Terms.input). A page sends keys without waiting for the last send to answer
// (each round trip to a cloud computer would hold up the next key): numbered (seq, counted per page:
// from), they may arrive out of order and go in in order. A gap (a send that failed) is skipped after
// GAP_MS. At most MAX_SENDERS pages are remembered; the oldest is forgotten first.

export const GAP_MS = 1000;
export const MAX_SENDERS = 8;

/** Schedules fn after ms; the returned function cancels it. */
export type Later = (ms: number, fn: () => void) => () => void;

interface Sender {
  next: number;
  held: Map<number, string>;
  cancel: (() => void) | null;
}

export class InputOrder {
  readonly #senders = new Map<string, Sender>();
  readonly #write: (data: string) => void;
  readonly #later: Later;

  constructor(write: (data: string) => void, later: Later) {
    this.#write = write;
    this.#later = later;
  }

  put(data: string, seq: number, from: string): void {
    let q = this.#senders.get(from);
    if (!q) {
      if (this.#senders.size >= MAX_SENDERS) this.#forgetOldest();
      q = { next: 0, held: new Map(), cancel: null };
      this.#senders.set(from, q);
    }
    if (seq < q.next) return; // sent again
    q.held.set(seq, data);
    this.#flush(q, false);
  }

  #forgetOldest(): void {
    for (const [from, s] of this.#senders) {
      s.cancel?.();
      this.#senders.delete(from);
      return;
    }
  }

  #flush(q: Sender, skip: boolean): void {
    if (skip && q.held.size) q.next = Math.min(...q.held.keys());
    for (let d = q.held.get(q.next); d !== undefined; d = q.held.get(q.next)) {
      this.#write(d);
      q.held.delete(q.next++);
    }
    q.cancel?.();
    q.cancel = q.held.size ? this.#later(GAP_MS, () => this.#flush(q, true)) : null;
  }

  dispose(): void {
    for (const q of this.#senders.values()) q.cancel?.();
    this.#senders.clear();
  }
}
