// Events (plan §6.11.2 rule 6): published after the emitting command commits, delivered asynchronously
// and in order, one queue per subscribing plugin so a slow one only delays itself. Delivery is
// at-least-once: a handler that throws gets the same envelope again (dedupe by `seq`). Past the cap a
// queue stops growing and its plugin is `lagging`: it catches up from the change feed by cursor.
import type { Disposable, EventEnvelope, PluginId, Seq } from './contract.ts';
import { glob } from './permissions.ts';
import { detached } from './trace-context.ts';

export interface EventBusOptions {
  cap?: number;
  /** tries per envelope and handler before it's recorded as failed and skipped */
  attempts?: number;
  now?: () => number;
  nextSeq?: () => Seq;
  onLagging?: (plugin: PluginId, fromSeq: Seq) => void;
  onFailure?: (plugin: PluginId, type: string, err: unknown, seq: Seq) => void;
}

interface Sub {
  plugin: PluginId;
  pattern: string;
  fn: (e: EventEnvelope) => void | Promise<void>;
}

interface Queue {
  items: EventEnvelope[];
  running: boolean;
  lagging: boolean;
  /** the first seq this plugin missed while lagging */
  missedFrom?: Seq;
  idle: (() => void)[];
}

export class EventBus {
  readonly #subs: Sub[] = [];
  readonly #queues = new Map<PluginId, Queue>();
  readonly #taps = new Set<(e: EventEnvelope) => void>();
  readonly #o: Required<Pick<EventBusOptions, 'cap' | 'attempts' | 'now' | 'nextSeq'>> & EventBusOptions;
  #seq = 0;

  constructor(o: EventBusOptions = {}) {
    this.#o = { cap: 10_000, attempts: 3, now: Date.now, nextSeq: () => ++this.#seq, ...o };
  }

  /** `type` is exact, `prefix.*` or `*`. */
  on(plugin: PluginId, pattern: string, fn: Sub['fn']): Disposable {
    const sub: Sub = { plugin, pattern, fn };
    this.#subs.push(sub);
    return {
      dispose: () => {
        const i = this.#subs.indexOf(sub);
        if (i >= 0) this.#subs.splice(i, 1);
      },
    };
  }

  /** A synchronous tap on every envelope (the sync layer, tests). */
  tap(fn: (e: EventEnvelope) => void): Disposable {
    this.#taps.add(fn);
    return { dispose: () => this.#taps.delete(fn) };
  }

  publish(plugin: PluginId, type: string, data: unknown): EventEnvelope {
    const e: EventEnvelope = { seq: this.#o.nextSeq(), type, plugin, at: this.#o.now(), data };
    for (const t of this.#taps) t(e);
    const to = new Set(this.#subs.filter((s) => glob(s.pattern, type)).map((s) => s.plugin));
    for (const p of to) this.#enqueue(p, e);
    return e;
  }

  #queue(p: PluginId): Queue {
    let q = this.#queues.get(p);
    if (!q) this.#queues.set(p, (q = { items: [], running: false, lagging: false, idle: [] }));
    return q;
  }

  #enqueue(p: PluginId, e: EventEnvelope): void {
    const q = this.#queue(p);
    if (q.items.length >= this.#o.cap) {
      if (!q.lagging) {
        q.lagging = true;
        q.missedFrom = e.seq;
        this.#o.onLagging?.(p, e.seq);
      }
      return;
    }
    q.items.push(e);
    if (!q.running) void this.#drain(p, q);
  }

  async #drain(p: PluginId, q: Queue): Promise<void> {
    q.running = true;
    // let the publisher finish first: delivery is never inside the emitting call
    await Promise.resolve();
    while (q.items.length) {
      const e = q.items[0];
      if (!e) break;
      for (const s of this.#subs.filter((x) => x.plugin === p && glob(x.pattern, e.type))) await this.#deliver(s, e);
      q.items.shift();
    }
    q.running = false;
    for (const fn of q.idle.splice(0)) fn();
  }

  async #deliver(s: Sub, e: EventEnvelope): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (!this.#subs.includes(s)) return; // unsubscribed (plugin went off) while queued
      try {
        await detached(() => s.fn(e));
        return;
      } catch (err) {
        if (attempt >= this.#o.attempts) {
          this.#o.onFailure?.(s.plugin, e.type, err, e.seq);
          return;
        }
      }
    }
  }

  lagging(p: PluginId): { fromSeq: Seq } | undefined {
    const q = this.#queues.get(p);
    return q?.lagging && q.missedFrom !== undefined ? { fromSeq: q.missedFrom } : undefined;
  }

  /** The plugin caught up from the change feed: deliver to it normally again. */
  caughtUp(p: PluginId): void {
    const q = this.#queues.get(p);
    if (!q) return;
    q.lagging = false;
    delete q.missedFrom;
  }

  /** Drop a plugin's queue (it went off). */
  drop(p: PluginId): void {
    const q = this.#queues.get(p);
    if (!q) return;
    q.items.length = 0;
    this.#queues.delete(p);
    for (const fn of q.idle.splice(0)) fn();
  }

  get busy(): boolean {
    for (const q of this.#queues.values()) if (q.running || q.items.length) return true;
    return false;
  }

  /** Resolves when every queue is empty. */
  async idle(): Promise<void> {
    for (let busy = [...this.#queues.values()].filter((q) => q.running || q.items.length); busy.length; busy = [...this.#queues.values()].filter((q) => q.running || q.items.length))
      await Promise.all(busy.map((q) => new Promise<void>((r) => q.idle.push(r))));
  }

  subscriptionsOf(p: PluginId): number {
    return this.#subs.filter((s) => s.plugin === p).length;
  }
  queued(p: PluginId): number {
    return this.#queues.get(p)?.items.length ?? 0;
  }
}
