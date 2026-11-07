// Waiting on wisp without polling it. v1's MCP server was a child process that polled wisp every 1.5 s
// for an answer, a subagent's report or a task to settle. In-process, a wait re-checks only when the
// runtime says something changed (a session changed, a turn ended, a question was asked), plus one slow
// re-check as a net for a missed event. Every wait ends when its call's signal aborts (the harness went,
// the HTTP request closed) or the plugin's scope ends (wisp is going): v1 mcp-gone.

export interface Timers {
  timeout(ms: number, fn: () => void): () => void;
}

/** How long the net waits between re-checks when no event comes. */
export const NET_MS = 15_000;

export class Changes {
  readonly #waiters = new Set<() => void>();
  readonly #timers: Timers;
  readonly #gone: AbortSignal;
  /** bumped by each poke: a change that lands while a check runs isn't missed */
  #gen = 0;

  constructor(timers: Timers, gone: AbortSignal) {
    this.#timers = timers;
    this.#gone = gone;
  }

  /** Something changed somewhere: every wait checks again. */
  poke(): void {
    this.#gen++;
    const all = [...this.#waiters];
    this.#waiters.clear();
    for (const w of all) w();
  }

  /** Resolves on the next change, after `ms`, or when a signal aborts; true when it was a change. */
  next(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const stops: (() => void)[] = [];
      const done = (changed: boolean): void => {
        for (const s of stops) s();
        this.#waiters.delete(wake);
        resolve(changed);
      };
      const wake = (): void => done(true);
      if (this.#gone.aborted || signal?.aborted) return resolve(false);
      this.#waiters.add(wake);
      stops.push(this.#timers.timeout(Math.max(0, ms), () => done(false)));
      for (const s of [this.#gone, signal]) {
        if (!s) continue;
        const off = (): void => done(false);
        s.addEventListener('abort', off, { once: true });
        stops.push(() => s.removeEventListener('abort', off));
      }
    });
  }

  /**
   * Calls `check` until it answers something other than undefined, re-checking on each change; resolves
   * to undefined when `until` passes or a signal aborts first.
   */
  async until<T>(check: () => Promise<T | undefined>, o: { until: number; now: () => number; signal?: AbortSignal | undefined }): Promise<T | undefined> {
    for (;;) {
      if (this.#gone.aborted || o.signal?.aborted) return undefined;
      const gen = this.#gen;
      const got = await check();
      if (got !== undefined) return got;
      const left = o.until - o.now();
      if (left <= 0) return undefined;
      if (gen === this.#gen) await this.next(Math.min(left, NET_MS), o.signal);
    }
  }

  get gone(): boolean {
    return this.#gone.aborted;
  }
}
