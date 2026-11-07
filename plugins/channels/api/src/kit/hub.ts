// size-ok: v1 remote.js's hub is one class, every method small; its per-channel Settings moved to the transports
// The hub (v1 server/remote.js): the config, the fan-out, and the signed answers. Each transport owns
// its wire and its part of Settings; the hub knows none of them by name, only their kind (a phone
// gets the Phone events, a thread transport answers only where it was asked) and Telegram's channel
// layer switch (`layer`). It does no I/O itself: what it keeps goes to `persist`, what it needs of
// wisp comes from `phone`, and crypto comes in as functions, so a test builds a real hub over fakes.

import type { Json } from '@wisp/kernel';
import type {
  ActArgs, ActionKind, AwayEntry, BoxApi, ChannelConfig, ChannelHub, Msg, Net, Phone, ProjectView, Remote, SessionView, Signed, Status,
  SummaryView, Thread, Transport, TransportDef,
} from '../index.ts';
import { KIND } from './channel.ts';
import { same } from './conversation.ts';
import { ranInstead } from './lists.ts';
import { defuse, needsWisp, scrubOut } from './policy.ts';
import { truncate } from './text.ts';

const MAX_HOPS = 5; // from a stalled helper up to the task with a thread
const AWAY_MAX = 200;
const EVENTS = ['waiting', 'finished'] as const;
/** v1's order of Settings' channels, so GET /remote reads the same. */
const ORDER = ['ntfy', 'telegram', 'github', 'slack', 'discord', 'email', 'routed'];

export const mask = (t: unknown): string => (t ? `••••${String(t).slice(-4)}` : '');
/** A masked token in a PUT means "unchanged". */
export const keep = (v: unknown, prev: unknown): unknown => (typeof v === 'string' && v.startsWith('••••') ? prev : v);

export interface HubCrypto {
  /** HMAC-SHA256 of data under key, base64url */
  hmac(key: string, data: string): string;
  /** SHA-256 hex */
  sha256(s: string): string;
  randomInt(min: number, max: number): number;
  randomHex(bytes: number): string;
}

/** What the hub starts from: what persist() last wrote. */
export interface HubState {
  cfg: Record<string, ChannelConfig>;
  events?: string[];
  secret?: string;
  remotes: Record<string, Remote>;
}

export interface HubDeps {
  phone: Phone;
  net: Net;
  box: BoxApi;
  clock: { now(): number };
  log: { warn(msg: string): void; info(msg: string): void };
  crypto: HubCrypto;
  /** the point's contributions, read live: a transport module may come on (or go off) after the hub */
  transports: readonly TransportDef[] | (() => readonly TransportDef[]);
  state: HubState;
  /** the whole config (cfg, events, secret): the host splits secrets from the rest */
  persist(s: { cfg: Record<string, ChannelConfig>; events: string[]; secret: string }): void;
  persistRemote(id: string, remote: Remote): void;
  changed(): void;
  timeout(ms: number, fn: () => void): void;
  tune?: Record<string, number | (() => number)>;
}

/** v1 Remote's tunables, which tests turn down. */
export const TUNE_DEFAULTS: Record<string, number | (() => number)> = {
  ntfyPollMs: 4000,
  tgLongPoll: 25,
  ghPollMs: 60_000, // per repo
  slackBackoffMs: 1000, // the first wait after a lost connection; it doubles
  slackPingMs: 30_000,
  discordBackoffMs: 1000,
  discordHelloMs: 30_000, // how long a new socket has to say hello
  discordIdentifyMs: 5000, // Discord's limit between identifies
  discordInvalidMs: 1000, // the least it waits after an invalid session
  discordJitter: Math.random, // where in the first interval the first heartbeat falls
};

const ordered = (defs: readonly TransportDef[]): TransportDef[] =>
  [...defs].sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));

export class Hub implements ChannelHub {
  readonly phone: Phone;
  readonly net: Net;
  readonly box: BoxApi;
  readonly clock: { now(): number };
  readonly log: { warn(msg: string): void; info(msg: string): void };
  readonly cfg: Record<string, ChannelConfig>;
  readonly status: Record<string, Status | null> = {};
  readonly away = new Map<string, AwayEntry>();
  readonly tgElsewhere = new Map<number, string>();
  readonly tune: Record<string, number | (() => number)>;
  /** the live transports by name, in Settings' order */
  channels: Record<string, Transport> = {};
  readonly #made = new Map<TransportDef, Transport>();
  readonly #deps: HubDeps;
  readonly #remotes: Map<string, Remote>;
  #events: string[];
  #secret: string;
  #ac: AbortController | null = null;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.phone = deps.phone;
    this.net = deps.net;
    this.box = deps.box;
    this.clock = deps.clock;
    this.log = deps.log;
    this.cfg = deps.state.cfg;
    this.#events = deps.state.events ?? [...EVENTS];
    this.#secret = deps.state.secret ?? '';
    this.#remotes = new Map(Object.entries(deps.state.remotes));
    this.tune = { ...TUNE_DEFAULTS, ...deps.tune };
    this.sync();
    // A task on another machine has no row here: its thread was kept in that channel's config.
    for (const [channel, c] of Object.entries(this.cfg)) {
      const away = c['away'];
      if (!away || typeof away !== 'object') continue;
      for (const [id, a] of Object.entries(away as Record<string, Record<string, unknown>>)) this.away.set(id, { channel, last: null, ...a });
    }
  }

  get events(): readonly string[] {
    return this.#events;
  }

  get secret(): string {
    if (!this.#secret) {
      this.#secret = this.#deps.crypto.randomHex(16);
      this.save();
    }
    return this.#secret;
  }

  /** any channel configured */
  get on(): boolean {
    return this.#transports().some((c) => c.ready);
  }

  /** Telegram's channel layer (v1 telegram.options) */
  get layer(): boolean {
    return this.#transports().some((c) => c.layer);
  }

  /** Makes a transport for each new contribution and stops the ones whose module went off. */
  sync(): void {
    const t = this.#deps.transports;
    const defs = ordered(typeof t === 'function' ? t() : t);
    for (const [def, made] of this.#made) {
      if (defs.includes(def)) continue;
      made.stop?.();
      this.#made.delete(def);
    }
    const next: Record<string, Transport> = {};
    for (const def of defs) {
      let made = this.#made.get(def);
      if (!made) {
        made = def.create(this);
        this.#made.set(def, made);
        if (made.view && !(def.name in this.status)) this.status[def.name] = null;
      }
      next[def.name] = made;
    }
    this.channels = next;
  }

  #transports(): Transport[] {
    this.sync();
    return Object.values(this.channels);
  }

  /** A transport by name, if its module is on. */
  transport(name: string): Transport | undefined {
    this.sync();
    return Object.hasOwn(this.channels, name) ? this.channels[name] : undefined;
  }

  /** A task was deleted: its thread goes too. */
  forget(id: string): void {
    this.#remotes.delete(id);
  }

  busy(): number {
    return this.#transports().reduce((n, c) => n + (c.busy?.() ?? 0), 0);
  }

  save(): void {
    this.#deps.persist({ cfg: this.cfg, events: this.#events, secret: this.#secret });
  }

  onChange(): void {
    this.#deps.changed();
  }

  timeout(ms: number, fn: () => void): void {
    this.#deps.timeout(ms, fn);
  }

  hash(s: string): string {
    return this.#deps.crypto.sha256(s);
  }

  randomInt(min: number, max: number): number {
    return this.#deps.crypto.randomInt(min, max);
  }

  randomHex(bytes: number): string {
    return this.#deps.crypto.randomHex(bytes);
  }

  start(): void {
    this.stop();
    const ac = (this.#ac = new AbortController());
    for (const t of this.#transports()) {
      Promise.resolve()
        .then(() => t.start(ac.signal))
        .catch((err: unknown) => this.log.warn(`channels: ${t.name}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  stop(): void {
    this.#ac?.abort();
    this.#ac = null;
    for (const t of this.#transports()) t.stop?.();
  }

  // ---------- what leaves ----------

  /** What the phone gets for a session that needs you, and the buttons under it. */
  message(s: SessionView, summary?: SummaryView | null): Msg {
    const where = `${summary?.project || ''}: ${s.title}`;
    if (s.ask) {
      return {
        title: `❓ ${where}`,
        text: [s.ask.question, s.ask.context && truncate(s.ask.context, 600)].filter(Boolean).join('\n\n'),
        actions: (s.ask.options || []).map((label, index) => ({ label, kind: 'answer' as const, ref: s.ask?.id ?? '', index })),
      };
    }
    const turn = s.turns.at(-1);
    const blocks = turn?.presentation?.blocks || [];
    const hero = blocks.find((b) => b?.type === 'hero') as { title?: string; summary?: string; status?: string } | undefined;
    const q = blocks.findLast((b) => b?.type === 'question') as { question?: string; options?: unknown[] } | undefined;
    const icon = ({ done: '✅', partial: '🟡', blocked: '⛔' } as Record<string, string>)[hero?.status ?? ''] || (turn?.status === 'error' ? '⛔' : '📝');
    const options = (q?.options || []).map((o) => (typeof o === 'string' ? { label: o } : (o as { label?: string; reply?: string })));
    // A quick answer has no hero, only its text: that text is the report.
    const plain = (blocks.find((b) => b?.type === 'markdown') as { text?: string } | undefined)?.text;
    const asked = turn?.model ?? s.model ?? '';
    const ran = ranInstead(asked, turn?.stats ?? null);
    return {
      title: `${icon} ${where}`,
      text: [hero?.title && hero.title !== s.title ? hero.title : '', hero?.summary || summary?.preview || (plain && truncate(plain, 1000)) || 'Ready for review.', ran && `Ran on ${ran}, not ${asked}.`, q?.question]
        .filter(Boolean)
        .join('\n\n'),
      actions: options.length
        ? options.map((o, index) => ({ label: o.label || String(o.reply || ''), kind: 'reply' as const, ref: turn?.id ?? '', index }))
        : [{ label: 'Mark done', kind: 'done' as const, ref: turn?.id || '', index: 0 }],
    };
  }

  /** A task is waiting or finished: the phone hears it if its events say so; its own thread always. */
  async notify(raw: SessionView | null, summary?: SummaryView | null): Promise<void> {
    if (!this.on || !raw || raw.agent === 'wisp') return;
    const s = this.withRemote(raw);
    const event = s.state === 'waiting' ? 'waiting' : 'finished';
    const chosen = this.#events.includes(event);
    const from = this.startedFrom(s);
    const lead = await this.#heldUp(s);
    const own = this.#reporting().some((c) => c.reports?.(lead)); // reported there whatever the events say
    const phones = this.#transports().filter((t) => t.kind === 'phone');
    if (!this.layer) {
      if (chosen || own) await this.send(this.message(s, summary), s, { skip: chosen ? [] : phones.map((t) => t.name) });
      return;
    }
    // Work that came from a channel answers there, whatever the events say. Anything else, a
    // scheduled check-in included, goes only where the Phone events already send it.
    const skip = phones.filter((t) => !(chosen || (t.layer && from?.channel === t.name))).map((t) => t.name);
    if (skip.length === phones.length && !own) return;
    const msg = this.message(s, summary);
    if (from?.by) msg.title = `${from.by}: ${msg.title}`;
    await this.send(msg, s, { skip });
  }

  /** → how many channels it went to. */
  async send(msg: Msg, raw: SessionView | null = null, { skip = [] as string[] } = {}): Promise<number> {
    const s = raw && this.withRemote(raw);
    const out = this.#safe(msg);
    const jobs: Promise<void>[] = [];
    const go = (c: Transport, about: SessionView | null): void => {
      jobs.push(c.publish(out, about).then(() => this.#mark(c, { ok: true }), (e: unknown) => this.#mark(c, { ok: false, error: e instanceof Error ? e.message : String(e) })));
    };
    for (const t of this.#transports()) if (t.kind === 'phone' && (t.sending ?? t.ready) && !skip.includes(t.name)) go(t, s);
    // Only what they started or followed up. Each defuses what it posts: others can read a report there.
    const lead = await this.#heldUp(s);
    for (const c of this.#reporting()) if (c.reports?.(lead)) go(c, lead);
    await Promise.all(jobs);
    return jobs.length;
  }

  #mark(c: Transport, st: Status): void {
    this.status[c.name] = { ...this.status[c.name], ...st, at: this.clock.now() };
    this.onChange();
  }

  /** The channels that answer where they were asked, and only there. */
  #reporting(): Transport[] {
    return this.#transports().filter((c) => c.kind === 'thread' && c.ready);
  }

  // Who a task is reported as. An ask only wisp can answer, in a subagent, a side discussion or a
  // delegated crew job, has no thread of its own: it's said in the thread of the task it came from.
  async #heldUp(s: SessionView | null): Promise<SessionView | null> {
    if (!s || !needsWisp(s.ask)) return s;
    let lead: SessionView = s;
    for (let hops = 0; hops < MAX_HOPS && !this.#reporting().some((c) => c.reports?.(lead)); hops++) {
      const id = lead.parentId || lead.sideOf?.id || (lead.crew?.job === 'delegated' ? lead.crew.from?.id : undefined);
      if (!id) break;
      const found = await this.phone.session(id).catch(() => null);
      const up = found ? this.withRemote(found) : this.away.has(id) ? ({ id, title: '', state: '', agent: '', turns: [] } satisfies SessionView) : null;
      if (!up) break;
      lead = up;
    }
    return lead === s ? s : { ...lead, ask: s.ask ?? null };
  }

  // What leaves: never a secret. With the layer on, nobody pinged by agent text either.
  #safe(msg: Msg): Msg {
    const on = this.layer;
    const clean = (t: string, o?: { note: boolean }): string => (on ? defuse(scrubOut(t, o).text) : scrubOut(t, o).text);
    return { ...msg, title: clean(msg.title, { note: false }), text: clean(msg.text), actions: (msg.actions || []).map((a) => ({ ...a, label: clean(a.label, { note: false }) })) };
  }

  // ---------- threads ----------

  remoteOf(id: string): Remote | undefined {
    return this.#remotes.get(id);
  }

  setRemote(id: string, remote: Remote): void {
    this.#remotes.set(id, remote);
    this.#deps.persistRemote(id, remote);
  }

  findRemote(pred: (r: Remote, id: string) => boolean): string[] {
    return [...this.#remotes].filter(([id, r]) => pred(r, id)).map(([id]) => id);
  }

  withRemote<S extends { id: string }>(s: S): S & { remote?: Remote } {
    const r = this.#remotes.get(s.id);
    return r ? { ...s, remote: r } : s;
  }

  /** Where a task that began in a channel came from: { channel, by }, or null. */
  startedFrom(s: SessionView | { id: string } | null): { channel: string; by?: string } | null {
    const r = s && this.#remotes.get(s.id);
    if (r?.started) return { channel: r.started, ...(r.by && { by: r.by }) };
    const a = s ? this.away.get(s.id) : undefined;
    return a ? { channel: a.channel, ...(a.by && { by: a.by }) } : null;
  }

  /** The message its reports go under. */
  threadOf(s: SessionView | null): unknown {
    const r = s && this.#remotes.get(s.id);
    if (r?.started) return r.tg?.at(-1) ?? null;
    return (s && this.away.get(s.id)?.last) ?? null;
  }

  /** A task here gets a row; one on a machine (`<id>@<machine>`) is only in `away`, as v1 kept it. */
  markStarted(id: string, channel: string, by?: string): void {
    if (!id.includes('@')) {
      this.setRemote(id, { ...this.#remotes.get(id), started: channel, ...(by && { by }) });
      return;
    }
    this.away.set(id, { channel, ...(by && { by }), last: null });
    if (this.away.size > AWAY_MAX) {
      const first = this.away.keys().next().value;
      if (first !== undefined) this.away.delete(first);
    }
  }

  /** A task or crew job from a channel began, or couldn't. */
  threadStarted(s: SessionView | null, thread: Thread | null, member: { name: string } | null, err?: Error): void {
    const c = thread ? this.transport(thread.channel) : undefined;
    try {
      if (c && thread) c.threadStarted?.(s, thread, member, err);
    } catch (e) {
      this.log.warn(`wisp: phone: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  act(a: ActArgs): Promise<string> {
    return this.phone.act(a);
  }

  launch(o: { project: ProjectView; prompt: string }): Promise<SessionView | null> {
    return this.phone.launch(o);
  }

  // ---------- answers: signed, so a stranger who guesses the topic can't steer your agents ----------

  sign(sessionId: string, kind: ActionKind, ref: string, index: number): string {
    return this.#deps.crypto.hmac(this.secret, `${sessionId}.${kind}.${ref}.${index}`).slice(0, 22);
  }

  verify(p: unknown): p is Signed {
    if (!p || typeof p !== 'object') return false;
    const x = p as Record<string, unknown>;
    const kind = typeof x['k'] === 'string' ? (KIND as Record<string, ActionKind | undefined>)[x['k']] : undefined;
    if (!kind || typeof x['sig'] !== 'string') return false;
    return same(this.sign(String(x['s']), kind, String(x['r']), Number(x['i'])), x['sig']);
  }

  /** The project /new uses without an @name: the one picked in settings, else the last used. */
  async defaultProject(): Promise<ProjectView | null> {
    const projects = await this.phone.projects();
    const id = this.cfg['telegram']?.['project'];
    return (typeof id === 'string' && id && projects.find((p) => p.id === id)) || [...projects].sort((a, b) => (b.lastUsedAt || b.addedAt || 0) - (a.lastUsedAt || a.addedAt || 0))[0] || null;
  }

  // ---------- Settings ----------

  /** GET /remote: every transport's part, plus health. */
  view(): Record<string, Json> {
    const out: Record<string, Json> = { events: [...this.#events] };
    for (const t of this.#transports()) {
      const v = t.view?.();
      if (v !== undefined) out[t.name] = v;
    }
    out['status'] = this.status as Json;
    return out;
  }

  /** PUT /remote: { events, <channel>: {…} }. Masked tokens mean "unchanged". */
  async update(body: Record<string, unknown> = {}): Promise<Record<string, Json>> {
    if (Array.isArray(body['events'])) this.#events = body['events'].filter((e): e is string => e === 'waiting' || e === 'finished');
    for (const t of this.#transports()) {
      const part = body[t.name];
      if (part && typeof part === 'object' && t.update) await t.update(part as Record<string, unknown>);
    }
    this.save();
    this.start();
    return this.view();
  }
}
