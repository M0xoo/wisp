// A channel: one way to reach wisp from outside. The hub owns the config, the public API and the
// fan-out; a channel owns its wire. The port of v1 server/channels/channel.js: a transport module
// extends `Channel` and gives it `kind`, `ready`, `start(signal)`, `publish(msg, s)`, `view()`, and
// whatever of `inbound`, `dropped`, `rotate`, `reports`, `threadStarted` it has.
// Inbound goes through policy.ts's gate() and grammar.ts's parseMessage(), then the hub's phone does the work.

import type { Json } from '@wisp/kernel';
import type { ActionKind, AskView, ChannelConfig, ChannelHub, InboundResult, Msg, SessionView, Status, Transport } from '../index.ts';
import { Seen, approvalsHere, needsWisp, waitingLine } from './policy.ts';

const AWAY_MAX = 200;
export const KIND: Readonly<Record<string, ActionKind>> = { a: 'answer', r: 'reply', d: 'done' };
export const CODE: Readonly<Record<ActionKind, string>> = { answer: 'a', reply: 'r', done: 'd' };
const SEND_TRIES = 3;

export const lostLine = (n: number): string =>
  n === 1 ? 'One message didn’t reach wisp while it was asleep. Send it again to run it.' : `${n} messages didn’t reach wisp while it was asleep. Send them again to run them.`;

/** Waits ms, or less when the signal aborts; the timer goes with the abort and never holds the process up. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * A post whose connection broke: fetch rejects with a TypeError and no answer, where a kept-alive
 * socket died under it or none could be had. Nothing says it wasn't heard, so it can show twice; that
 * beats a question or a first reply that never comes. A refusal, a timeout and an abort aren't this.
 */
export async function resend<T>(send: () => Promise<T>, tries = SEND_TRIES): Promise<T> {
  for (let left = tries; ; left--) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'TypeError') throw err;
      if (left <= 1) {
        const cause = (err as { cause?: { code?: unknown } }).cause;
        throw new Error(`${err.message}${cause?.code ? ` (${String(cause.code)})` : ''}`); // fetch's own words hide why
      }
    }
  }
}

export abstract class Channel implements Pick<Transport, 'name' | 'ready' | 'start' | 'publish' | 'busy'> {
  readonly hub: ChannelHub;
  readonly name: string;
  abstract readonly kind: 'phone' | 'thread';
  readonly asksSaid = new Seen();
  /** thread → sends the first reply that didn't get out */
  readonly owed = new Map<unknown, () => Promise<unknown>>();

  constructor(hub: ChannelHub, name: string) {
    this.hub = hub;
    this.name = name;
  }

  get ready(): boolean {
    return false;
  }

  get approvalsHere(): boolean {
    return approvalsHere(this.name);
  }

  /** This channel's config (created empty the first time). */
  get cfg(): ChannelConfig {
    const all = this.hub.cfg;
    return (all[this.name] ||= {});
  }

  /**
   * A publish about an ask that only wisp can answer: the line to post instead of the report, or
   * '' when this ask has been said here. null: no such ask. A restart ends every ask, so memory is
   * enough to say each once.
   */
  waiting(s: { ask?: AskView | null | undefined } | null | undefined, opts?: { bare?: boolean }): string | null {
    const ask = s?.ask;
    if (this.approvalsHere || !ask || !needsWisp(ask)) return null;
    return this.asksSaid.first(ask.id) ? waitingLine(ask, opts) : '';
  }

  start(_signal: AbortSignal): void | Promise<void> {}

  async publish(_msg: Msg, _s: SessionView | null): Promise<void> {}

  /**
   * A task on another machine has no s.remote here: its thread (fields) is kept in config, as
   * hub.away is memory and the task outlives a restart. The hub reads it back when it starts.
   */
  keepAway(id: string, by: string | null | undefined, fields: Record<string, unknown>): void {
    const hub = this.hub;
    const entry = { ...(by && { by }), ...fields, at: hub.clock.now() };
    const live = hub.away.get(id);
    if (live) Object.assign(live, entry);
    const cfg = this.cfg;
    const away = (typeof cfg['away'] === 'object' && cfg['away'] !== null ? cfg['away'] : {}) as Record<string, unknown>;
    cfg['away'] = Object.fromEntries(Object.entries({ ...away, [id]: entry }).slice(-AWAY_MAX));
    hub.save();
  }

  /** Keeps the first reply when it couldn't be sent: the task is running, so it's still true. */
  owe(key: unknown, send: () => Promise<unknown>): (err: unknown) => never {
    return (err) => {
      this.owed.set(key, send);
      throw err;
    };
  }

  /** Answers under way that nothing else shows: work after() started, a report on its way. */
  busy(): number {
    return 0;
  }

  /** It goes ahead of the next thing said in that thread, or stays for the one after. */
  async pay(key: unknown): Promise<void> {
    const send = this.owed.get(key);
    if (!send) return;
    this.owed.delete(key);
    await send().catch(() => this.owed.set(key, send));
  }

  async inbound(_raw: Uint8Array, _headers: Readonly<Record<string, string | string[] | undefined>>, _opts: { at: number; verified: boolean }): Promise<InboundResult> {
    return { status: 404, body: { error: 'This channel has no inbound here.' } };
  }

  async dropped(_n: number): Promise<void> {}

  async rotate(): Promise<{ status: number; body: Json }> {
    return { status: 404, body: { error: 'This channel has no URL to rotate.' } };
  }

  /** Health for Settings: the latest result, merged over the last one. */
  mark(st: Status): void {
    this.hub.status[this.name] = { ...this.hub.status[this.name], ...st, at: this.hub.clock.now() };
    this.hub.onChange();
  }
}
