// Where it went (v1 Budget.begin/end/#sharers): the turns that ran on an account between two of its
// reports. Kept in memory: after a restart, what ran before it isn't traced.

const MAX_LEDGER = 100; // turns remembered per account between two reports

export interface Entry {
  sid: string;
  tid: string;
  from: number;
  to: number | null;
}

export class Ledger {
  readonly #byKey = new Map<string, Entry[]>();

  #list(key: string): Entry[] {
    let list = this.#byKey.get(key);
    if (!list) {
      list = [];
      this.#byKey.set(key, list);
    }
    return list;
  }

  /** a turn starts on an account */
  begin(key: string, sid: string, tid: string, now: number): void {
    const list = this.#list(key);
    list.push({ sid, tid, from: now, to: null });
    if (list.length > MAX_LEDGER) list.splice(0, list.length - MAX_LEDGER);
  }

  /** a turn ends: on whichever account it began on */
  end(sid: string, tid: string, now: number): void {
    for (const list of this.#byKey.values()) {
      const e = list.findLast((x) => x.sid === sid && x.tid === tid && !x.to);
      if (e) e.to = now;
    }
  }

  /** the account a running turn began on, if wisp saw it begin */
  keyOf(sid: string, tid: string): string | undefined {
    for (const [key, list] of this.#byKey) if (list.some((x) => x.sid === sid && x.tid === tid)) return key;
    return undefined;
  }

  /**
   * [[turn, part]]: each turn's part of the time turns ran on the account since `since` (the last
   * report); the ones that ended are let go. None: the move happened outside wisp.
   */
  sharers(key: string, since: number | undefined, now: number): [Entry, number][] {
    const list = this.#list(key);
    const start = since || now;
    const spans = list
      .map((e): [Entry, number] => [e, Math.max(0, Math.min(e.to ?? now, now) - Math.max(e.from, start))])
      // A run that reports the moment it starts (no time yet) still counts: it's what moved it.
      .filter(([e, ms]) => ms > 0 || (!e.to && e.from >= start));
    const total = spans.reduce((t, [, ms]) => t + ms, 0);
    this.#byKey.set(key, list.filter((e) => !e.to));
    return spans.map(([e, ms]) => [e, total ? ms / total : 1 / spans.length]);
  }
}
