// What a message does once it's through a channel's door, written once. A channel hands in `c`, what
// differs for it (the Conversation below), and the channels keep only their wire and who may speak.
// The port of v1 server/channels/conversation.js.

import type { ChannelConfig, ChannelCtx, ChannelHub, Mode, Parsed, Phone, Problem, Thread } from '../index.ts';
import { parseMessage } from './grammar.ts';
import { LISTS, isList, refusal } from './lists.ts';
import { capMode, hideNames } from './policy.ts';
import { truncate } from './text.ts';

const LINK_TRIES = 5; // wrong codes before the code changes
const LINK_DAY = 50; // wrong codes a day, from everyone: past them, nobody links until tomorrow
const LINK_EACH = 5; // wrong codes a day, from one sender: so it takes many to use up LINK_DAY

export const newLinkCode = (hub: Pick<ChannelHub, 'randomInt'>): string => String(hub.randomInt(100000, 999999));
export const firstPart = (line: unknown): string => `${(String(line).split(':')[0] ?? '').replace(/\.$/, '')}.`;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const failedLine = (what: string, err: unknown): string => `Couldn’t ${what}: ${truncate(errMessage(err), 300)}`;

export type Say = (text: string) => Promise<unknown>;
export type ListFn = (p: Parsed, ctx: ChannelCtx) => Promise<unknown>;

/** What differs per channel in a conversation (v1 conversation.js's `c`). */
export interface Conversation {
  phone: Phone;
  hub: Pick<ChannelHub, 'act'>;
  ctx: ChannelCtx;
  channel: string;
  name: string;
  sender: string;
  cap: Mode;
  fallback?: Mode;
  about?: string;
  approvals: boolean;
  say: Say;
  list: ListFn;
  refuse: (problems: readonly Problem[]) => Promise<unknown>;
  /** where a task started here answers */
  thread(p: Parsed): Promise<Thread | null> | Thread | null;
  /** the line for `stop` out of a thread */
  noThread: string;
  /** a line when the message points at something gone */
  stale?(p: Parsed): string | null | undefined;
  acked?(thread: Thread | null, sent: unknown): void;
  /** keeps a first reply that couldn't go, for the next thing said in that thread */
  owe?(send: () => Promise<unknown>): (err: unknown) => never;
  /** status with less in it */
  quiet?(line: string): string;
  /** so a follow-up's answer */
  runLine?(line: string): string;
  later?(text: string): void;
  /** → undo */
  beforeRun?(sessionId: string): (() => void) | null | undefined;
  failed?(what: string, err: unknown): string;
  btwHelp?: string;
}

export interface SurfaceArgs {
  ctx: Parameters<typeof hideNames>[1];
  post: Say;
  /** a place only you read: lists and names as they are */
  open: boolean;
  typed: string;
  /** the one fixed line for a list where others can read */
  noList: string;
}

/**
 * say, refuse and list for a place others can read, or not (open). There a list is one fixed line,
 * help has nothing of yours in its example, a refusal has no choices, and anything else said loses
 * names you didn't write there. typed: what this message said, and what's already known there.
 */
export function surface({ ctx, post, open, typed, noList }: SurfaceArgs): { say: Say; refuse: (problems: readonly Problem[]) => Promise<unknown>; list: ListFn } {
  const say: Say = (t) => post(open ? t : hideNames(t, ctx, typed));
  return {
    say,
    refuse: (problems) => say(refusal(open ? problems : problems.map((x) => ({ ...x, choices: [] })))),
    list: (p, c) => {
      const name = p.command;
      if (open) return say(isList(name) ? LISTS[name](c, p.arg) : '');
      if (name === 'help') return post(LISTS.help({}));
      if (name !== 'status') return post(noList);
      return post(`${c.tasks.filter((s) => s.state === 'running').length} running, ${c.tasks.filter((s) => s.state === 'waiting').length} waiting: see them in wisp.`);
    },
  };
}

/**
 * text: the message, through stripFormatting. sessionId: the task its thread belongs to, if any.
 * threadText: the same message as it reads in that thread.
 */
export async function converse(c: Conversation, text: string, sessionId: string | null = null, threadText: string = text): Promise<unknown> {
  if (sessionId) {
    const p = parseMessage(threadText, { ...c.ctx, thread: await c.phone.threadCtx(sessionId) });
    if (p.command !== 'new') return inThread(c, sessionId, p);
  }
  return start(c, parseMessage(text, c.ctx));
}

const extras = (c: Conversation): { fallback?: Mode; about?: string } => ({ ...(c.fallback && { fallback: c.fallback }), ...(c.about && { about: c.about }) });

async function start(c: Conversation, p: Parsed): Promise<unknown> {
  const { phone, ctx, say } = c;
  if (p.command && p.command !== 'new') {
    phone.count('list', p.command);
    if (isList(p.command)) return c.list(p, ctx);
    return say(c.noThread); // stop, done, /btw
  }
  const stale = c.stale?.(p);
  if (stale) return say(stale);
  if (p.problems.length) {
    phone.count('refused', p.problems[0]?.kind ?? '');
    return c.refuse(p.problems);
  }
  if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
  const asked = capMode(p.mode, c.cap, c.fallback ?? 'plan');
  if (asked.refused) {
    phone.count('refused', 'mode');
    return say(`${asked.refused}\n\nNothing started.`);
  }
  if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
  const thread = await c.thread(p);
  let out: { ack: string };
  try {
    out = await phone.startParsed(p, { channel: c.channel, name: c.name, sender: c.sender, cap: c.cap, ...extras(c), thread, ctx });
  } catch (err) {
    return say((c.failed || failedLine)('start it', err));
  }
  const ack = (): Promise<unknown> => say(out.ack);
  const sent = await (c.owe ? ack().catch(c.owe(ack)) : ack());
  c.acked?.(thread, sent);
  return sent;
}

async function mentionIn(c: Conversation, sessionId: string, p: Parsed, name: string): Promise<unknown> {
  if (!p.prompt) return c.say(`Tell ${name} what to do after the name.`);
  const thread = await c.thread(p);
  let out: { ack: string };
  try {
    out = await c.phone.mention(sessionId, p, { channel: c.channel, name: c.name, sender: c.sender, cap: c.cap, ...extras(c), thread, ctx: c.ctx });
  } catch (err) {
    return c.say((c.failed || failedLine)('ask them', err));
  }
  const sent = await c.say(out.ack);
  c.acked?.(thread, sent);
  return sent;
}

async function inThread(c: Conversation, sessionId: string, p: Parsed): Promise<unknown> {
  const { phone, hub, ctx, say } = c;
  const quiet = c.quiet || ((line: string): string => line);
  if (isList(p.command) && p.command !== 'status') return c.list(p, ctx);
  if (p.command === 'stop') return say(await phone.stop(sessionId));
  if (p.command === 'status') return say(quiet(await phone.status(sessionId)));
  if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
  if (p.problems.length) return c.refuse(p.problems);
  if (p.crew) return mentionIn(c, sessionId, p, p.crew.name);
  const btw = p.command === 'btw';
  if (!p.prompt) return say(btw ? c.btwHelp || 'Type your question after /btw.' : 'What should it do? Say it after the options.');
  const asked = capMode(p.mode, c.cap, p.mode ?? undefined);
  if (asked.refused) return say(asked.refused);
  const later = c.later ? (text: string): void => c.later?.(text) : (text: string): void => void say(text).catch(() => {});
  const undo = btw ? null : c.beforeRun?.(sessionId);
  // Only the follow-up itself: a reply that fails to arrive mustn't say it wasn't sent, or it gets
  // sent twice.
  let line: string;
  try {
    line = await phone.run(sessionId, p, { name: c.name, sender: c.sender, cap: c.cap, later, btw, ...(c.about && { about: c.about }), approvals: c.approvals });
    if (!line.startsWith('✓')) undo?.(); // refused: no turn is coming
    line = c.runLine ? c.runLine(line) : line;
  } catch (err) {
    undo?.();
    line = (c.failed || failedLine)('send that', err);
  }
  return say(line);
}

/** Equal strings, in time that doesn't depend on where they differ (no node:crypto in an api package). */
export const same = (a: unknown, b: unknown): boolean => {
  const [x, y] = [new TextEncoder().encode(String(a)), new TextEncoder().encode(String(b))];
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

/** The day's wrong codes (kept in the config: a cloud wisp forgets the rest each time it sleeps). */
export interface LinkGuess {
  day: string;
  wrong: number;
  spent: number;
  /** wrong codes per sender, by a hash of who: one stranger can't spend everyone's day */
  by?: Record<string, number>;
}

export interface LinkCfg {
  senders?: string[];
  linkCode?: string;
  linkGuess?: LinkGuess;
}

/** The channel Linking works for: its config, its hub, its name. */
export interface Linkable {
  readonly name: string;
  readonly cfg: ChannelConfig & LinkCfg;
  readonly hub: Pick<ChannelHub, 'save' | 'onChange' | 'phone' | 'hash' | 'randomInt' | 'clock'>;
}

/**
 * `link <code>` in a private message. where: where wisp shows the code. A code links one person, and
 * guessing changes it. A new code from wisp (Unlink) starts the day again; one the guessing changed doesn't.
 */
export class Linking {
  readonly channel: Linkable;
  readonly limit: () => { hit(user: string): { ok: boolean } };
  readonly where: string;
  readonly done: string;
  constructor(channel: Linkable, { limit, where, done }: { limit: () => { hit(user: string): { ok: boolean } }; where: string; done: string }) {
    this.channel = channel;
    this.limit = limit;
    this.where = where;
    this.done = done;
  }

  #guesser(user: string): string {
    return this.channel.hub.hash(`link:${this.channel.name}:${user}`).slice(0, 16);
  }

  attempt<R>(user: string, code: string | null | undefined, say: (text: string) => R): R | undefined {
    const c = this.channel.cfg;
    const hub = this.channel.hub;
    if ((c.senders || []).includes(user)) return say('You’re already linked.');
    if (!this.limit().hit(user).ok) return undefined;
    const day = new Date(hub.clock.now()).toISOString().slice(0, 10);
    const g: LinkGuess = c.linkGuess?.day === day ? c.linkGuess : { day, wrong: c.linkGuess?.wrong || 0, spent: 0 };
    const who = this.#guesser(user);
    const theirs = g.by?.[who] || 0;
    if (g.spent >= LINK_DAY || theirs >= LINK_EACH) return undefined; // the right code too: else guessing goes on
    if (!code || !c.linkCode || !same(code, c.linkCode)) {
      // Guessing is slow per person; this makes it slow for a whole workspace.
      const next: LinkGuess = { ...g, wrong: g.wrong + 1, spent: g.spent + 1, by: { ...g.by, [who]: theirs + 1 } };
      c.linkGuess = next;
      if (next.wrong >= LINK_TRIES) {
        next.wrong = 0;
        c.linkCode = newLinkCode(hub);
        hub.onChange();
      }
      hub.save();
      return say(`That isn’t the code. wisp shows it in ${this.where}.`);
    }
    c.linkGuess = { ...g, wrong: 0 };
    c.senders = [...(c.senders || []), user];
    c.linkCode = newLinkCode(hub); // one person, one code
    hub.save();
    hub.onChange();
    hub.phone.count('linked');
    return say(this.done);
  }
}

/**
 * The work behind an ack: one at a time per key, side by side across keys; and, per key, what's being
 * answered now, so a quick task's report comes after its first reply.
 */
export class Turns {
  readonly chains = new Map<unknown, Promise<unknown>>();
  readonly answering = new Map<unknown, Promise<unknown>>();

  queue<T>(key: unknown, fn: () => T | Promise<T>, onError: (err: unknown) => unknown): Promise<unknown> {
    const work: Promise<unknown> = (this.chains.get(key) || Promise.resolve())
      .then(fn)
      .catch(onError)
      .finally(() => {
        if (this.chains.get(key) === work) this.chains.delete(key);
      });
    this.chains.set(key, work);
    return work;
  }

  hold<T>(key: unknown, work: Promise<T>): Promise<T> {
    this.answering.set(key, work);
    return work.finally(() => {
      if (this.answering.get(key) === work) this.answering.delete(key);
    });
  }

  settled(key: unknown): Promise<unknown> | undefined {
    return this.answering.get(key)?.catch(() => {});
  }
}
