// @wisp-plugin/channels-api: the contract of wisp.channels, the hub every way of reaching wisp from
// outside goes through (ntfy, Telegram, Slack, Discord, GitHub, email, the grid's routed messages).
// The hub owns the config, the public API, the fan-out and what a message may do; a transport (a module
// of wisp.channels, point `channels.transport@1`) owns only its wire.
//
// Shared, pure code every transport needs (who may speak, the grammar, the lists, the conversation
// flow, the base channel) is in `@wisp-plugin/channels-api/kit`; a fake hub for transport tests is in
// `@wisp-plugin/channels-api/testing` (ADR-0012). Both are the port of v1's server/channels/*.js.

import type { Json } from '@wisp/kernel';
import type { Mode } from '@wisp-plugin/runtime-api';

export type { Mode };

// ---------- the point ----------

export const POINT = 'channels.transport';
export const POINT_VERSION = 1;

/** What a transport module contributes into `channels.transport@1`. */
export interface TransportDef {
  /** 'telegram', 'slack', …: the key of its config, its status and its part of GET /remote */
  name: string;
  /** made once per hub; the hub hands itself in */
  create(hub: ChannelHub): Transport;
  /** config fields (dotted: 'hook.secret') kept in ~/.wisp/secrets.json, never in the store */
  secrets?: readonly string[];
}

/** One way to reach wisp from outside (v1 server/channels/channel.js). */
export interface Transport {
  readonly name: string;
  /** configured well enough to send */
  readonly ready: boolean;
  /**
   * 'phone' (ntfy, Telegram): gets the Phone events (waiting, finished) for every task.
   * 'thread' (Slack, Discord, GitHub, email, routed): answers only where it was asked (`reports`).
   */
  readonly kind: 'phone' | 'thread';
  /** a phone transport that can send now (Telegram: linked to a chat). Defaults to `ready`. */
  readonly sending?: boolean;
  /** Telegram's channel layer (v1 telegram.options): the hub defuses what leaves, and routes reports by origin */
  readonly layer?: boolean;
  /**
   * Called for every transport on each (re)start of the hub, ready or not: one that isn't ready
   * returns at once, after what being off needs (Telegram takes down a webhook an earlier run left,
   * Discord takes its key off the grid). A ready one listens until the signal aborts.
   */
  start(signal: AbortSignal): void | Promise<void>;
  /** send { title, text, actions } about session s (or nothing in particular) */
  publish(msg: Msg, s: SessionView | null): Promise<void>;
  /** a thread transport: this task is reported here */
  reports?(s: SessionView | null): boolean;
  /** a message the grid held for this cloud wisp: verify it, handle it. A 4xx is final; only a 2xx means handled. */
  inbound?(raw: Uint8Array, headers: Readonly<Record<string, string | string[] | undefined>>, opts: { at: number; verified: boolean }): Promise<InboundResult>;
  /** the grid lost n of this channel's messages (a full grid, an hour asleep) */
  dropped?(n: number): Promise<void>;
  /** replace this cloud wisp's inbound URL, and point the channel at the new one */
  rotate?(): Promise<{ status: number; body: Json }>;
  /** answers under way that nothing else shows (for /api/status) */
  busy?(): number;
  /** a task or crew job from this channel began, or couldn't */
  threadStarted?(s: SessionView | null, thread: Thread, by: { name: string } | null, err?: Error): void;
  /** its part of GET /remote: config with secrets masked, plus health. None: not in Settings (routed). */
  view?(): Json;
  /** its part of PUT /remote; masked tokens mean unchanged. Throws a 400-ish WireError to refuse. */
  update?(body: Record<string, unknown>): void | Promise<void>;
  /** the stop of the hub: free what start() did not tie to its signal */
  stop?(): void;
  /** extra routes this transport answers under GET /remote/<name>/<what> (Slack's manifest, Discord's invite) */
  extra?(what: string): Promise<Json> | Json;
}

export interface InboundResult {
  status: number;
  body: Json;
  /** runs once the answer has gone: what must wait for the grid to hear it */
  after?: () => void;
}

// ---------- messages ----------

export type ActionKind = 'answer' | 'reply' | 'done';

export interface Action {
  label: string;
  kind: ActionKind;
  /** the ask id (answer) or the turn id (reply, done) */
  ref: string;
  index: number;
}

/** What the hub sends: v1 Remote.message(). */
export interface Msg {
  title: string;
  text: string;
  actions: Action[];
}

/** A signed tap (ntfy's buttons, Telegram's callback data): `{ s, k, r, i, sig }`. */
export interface Signed {
  s: string;
  k: string;
  r: string;
  i: number | string;
  sig: string;
}

// ---------- the task as a channel sees it ----------

/** An ask a task waits on (wisp.mcp's ask_user, approve, a clash card, a connector's sign-in). */
export interface AskView {
  id: string;
  question?: string;
  options?: string[];
  context?: string;
  permission?: { tool?: string; action?: string; detail?: string; why?: string };
  clash?: Json;
  connector?: Json;
}

export interface BlockView {
  type: string;
  [k: string]: unknown;
}

export interface TurnView {
  id: string;
  status: string;
  model?: string;
  stats?: { totals?: Json; models?: Record<string, Json>; [k: string]: unknown } | null;
  presentation?: { blocks: BlockView[] } | null;
  btw?: { id: string; status: string; answer?: string; error?: string }[];
}

/** What a channel keeps about a task (v1 s.remote): where it started, its thread there. */
export interface Remote {
  /** the channel it was started from */
  started?: string;
  /** who started it, by display name */
  by?: string;
  /** Telegram: the messages its reports go under, oldest first */
  tg?: number[];
  /** a routed thread (the grid's) */
  routed?: string;
  /** per-transport thread data: `slack: { channel, ts }`, `github: { repo, issue }`, … */
  [channel: string]: Json | undefined;
}

/** v1's session JSON, the part channels read. `remote` is channels' own row (table channels_thread). */
export interface SessionView {
  id: string;
  title: string;
  /** v1's states: 'waiting' when an ask is open */
  state: 'running' | 'waiting' | 'review' | 'done' | 'error' | (string & {});
  agent: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  cwd?: string;
  kind?: string;
  parentId?: string;
  sideOf?: { id: string };
  crew?: { id?: string; job?: string; from?: { id: string } };
  capped?: { mode: Mode } | null;
  ask?: AskView | null;
  queue?: unknown[];
  queueHeld?: boolean;
  delegated?: boolean;
  tui?: boolean;
  turns: TurnView[];
  remote?: Remote;
}

/** The list row the phone's message reads (project name, preview). */
export interface SummaryView {
  project?: string;
  preview?: string;
}

/** Where a task started from a channel answers (kept with a crew job that has to wait). */
export interface Thread {
  channel: string;
  ref?: string;
  session?: string;
  ack?: unknown;
  [k: string]: unknown;
}

// ---------- what channels needs of wisp (v1 services/phone.js) ----------

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  machine?: string;
  repo?: string;
  lastUsedAt?: number;
  addedAt?: number;
}

export interface ModelView {
  id: string;
  label?: string;
  efforts?: string[];
}

export interface AgentView {
  id: string;
  name?: string;
  available?: boolean;
  signedIn?: boolean;
  models?: ModelView[];
  efforts?: string[];
}

export interface MachineView {
  id: string;
  name: string;
  kind?: string;
  computer?: boolean;
  usable?: boolean;
  agents?: AgentView[] | null;
}

export interface MemberView {
  id: string;
  name: string;
  role?: string;
  agent: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  cwd?: string;
  machine?: string;
  sandbox?: boolean;
  paused?: boolean;
  running?: number;
  queue?: unknown[];
}

/** A harness as the lists read it: its name and what it really runs in a mode. */
export interface AdapterView extends AgentView {
  modelOverride?(o: { model: string; mode: Mode }): { label: string; note: string } | null;
}

/** Everything a message may pick from (grammar, lists). */
export interface ChannelCtx {
  projects: ProjectView[];
  machines: MachineView[];
  agents: AgentView[];
  adapters: AdapterView[];
  crew: MemberView[];
  crewView?: MemberView[];
  goals: string[];
  defaultProject: ProjectView | null;
  defaultAgent: string;
  sandbox: boolean;
  tasks: { id: string; title: string; state: string }[];
  /** in a task's thread: where its follow-up runs */
  thread?: { agent: string; machine: string } | undefined;
  /** a router's grammar: whole names only */
  exact?: boolean;
}

/** grammar.parseMessage's answer. */
export interface Parsed {
  command: string | null;
  arg: string;
  crew: MemberView | null;
  tagged: MemberView[];
  project: ProjectView | null;
  machine: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  mode: Mode | null;
  prompt: string;
  problems: Problem[];
  notes: string[];
}

export interface Problem {
  kind: string;
  text: string;
  choices: string[];
}

export interface StartOpts {
  channel: string;
  name: string;
  sender?: string;
  /** the most this chat may ask for */
  cap?: Mode;
  /** the mode when none was asked for */
  fallback?: Mode;
  about?: string;
  thread?: Thread | null;
  ctx?: ChannelCtx | null;
}

export interface RunOpts {
  name: string;
  sender?: string;
  cap?: Mode;
  later?: ((text: string) => void) | undefined;
  btw?: boolean;
  about?: string;
  /** false: a channel that can't answer a tool approval */
  approvals?: boolean;
}

export interface ActArgs {
  sessionId: string;
  kind: ActionKind | 'text';
  ref?: string;
  index?: number;
  text?: string;
  later?: (text: string) => void;
  approvals?: boolean;
}

/** v1 phoneActions(app): what the channel layer asks of wisp. The host implements it with commands. */
export interface Phone {
  context(): Promise<ChannelCtx>;
  /** counts only, and only fixed values: never what a message said */
  count(kind: string, detail?: string): void;
  /** a routed message's way back: through the grid, which holds the bot */
  onGrid(): boolean;
  gridReply(thread: string, text: string): Promise<unknown>;
  /** a queued job's thread got its first reply */
  threadSaved(): void;
  threadCtx(sessionId: string): Promise<{ agent: string; machine: string }>;
  startParsed(p: Parsed, o: StartOpts): Promise<{ ack: string; session?: SessionView; queued?: number }>;
  stop(sessionId: string): Promise<string>;
  status(sessionId: string): Promise<string>;
  run(sessionId: string, p: Parsed, o: RunOpts): Promise<string>;
  mention(sessionId: string, p: Parsed, o: StartOpts): Promise<{ ack: string; queued?: number }>;
  launch(o: { project: ProjectView; prompt: string }): Promise<SessionView | null>;
  act(a: ActArgs): Promise<string>;
  /** the user's projects (the default project, Telegram's /new) */
  projects(): Promise<ProjectView[]>;
  /** a task here or on a machine (`<id>@<machine>`), with its turns and ask, or null */
  session(id: string): Promise<SessionView | null>;
  /** running or waiting top-level tasks here (status lists, a thread's lookups) */
  sessions(): Promise<SessionView[]>;
}

// ---------- what a transport gets from the hub (v1 Remote, the part channels used) ----------

/** A channel's config as v1 kept it in config.remote.<name>; secrets and the on switch are merged in. */
export type ChannelConfig = Record<string, unknown> & { enabled?: boolean };

/** The grid, from a cloud wisp's side (v1 channels/box.js). */
export interface BoxGrid {
  grid: string;
  auth: string;
}

export interface BoxApi {
  /** { grid, auth }, or null: not on a grid, or a sandbox */
  grid(): BoxGrid | null;
  /** on a grid box at all (v1 inBox) */
  inBox(): boolean;
  /** proof of the token, not the token */
  botMark(token: string): string;
  channelUrl(box: BoxGrid, channel: string, bot?: string, o?: { gone?: boolean }): Promise<{ url?: string; address?: string; dropped?: number; held?: boolean } | null>;
  rotateUrl(box: BoxGrid, channel: string): Promise<{ url?: string; address?: string }>;
  mailReply(box: BoxGrid, o: { replyTo: string; subject: string; text: string }): Promise<{ messageId?: string }>;
  setChannelKey(box: BoxGrid, channel: string, key: string, linked: string[]): Promise<boolean>;
}

export interface Net {
  fetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

export interface Status {
  ok?: boolean;
  error?: string;
  at?: number;
  [k: string]: Json | undefined;
}

export interface AwayEntry {
  channel: string;
  by?: string;
  last: unknown;
  at?: number;
  [k: string]: unknown;
}

export interface ChannelHub {
  readonly phone: Phone;
  readonly net: Net;
  readonly box: BoxApi;
  readonly clock: { now(): number };
  readonly log: { warn(msg: string): void; info(msg: string): void };
  /** every channel's config by name (mutable: change it, then save()) */
  readonly cfg: Record<string, ChannelConfig>;
  /** the phone's events: 'waiting', 'finished' */
  readonly events: readonly string[];
  /** health per channel, for Settings */
  readonly status: Record<string, Status | null>;
  /** sessions on another machine: what s.remote holds for one here */
  readonly away: Map<string, AwayEntry>;
  /** Telegram message id → session id, for sessions on a machine */
  readonly tgElsewhere: Map<number, string>;
  /** tunables tests turn down (v1 Remote fields: ntfyPollMs, tgLongPoll, slackBackoffMs, …) */
  readonly tune: Record<string, number | (() => number)>;
  /** writes cfg (secrets to the secrets file, the rest to channels' table) */
  save(): void;
  /** Settings should look again */
  onChange(): void;
  /** restart every transport (a changed config) */
  start(): void;
  /** a task's channel row (v1 s.remote), sync: the hub keeps them in memory */
  remoteOf(id: string): Remote | undefined;
  setRemote(id: string, remote: Remote): void;
  /** ids whose remote matches */
  findRemote(pred: (r: Remote, id: string) => boolean): string[];
  /** the session with its remote merged in */
  withRemote<S extends { id: string }>(s: S): S & { remote?: Remote };
  act(a: ActArgs): Promise<string>;
  launch(o: { project: ProjectView; prompt: string }): Promise<SessionView | null>;
  sign(sessionId: string, kind: ActionKind, ref: string, index: number): string;
  verify(p: unknown): p is Signed;
  startedFrom(s: SessionView | { id: string } | null): { channel: string; by?: string } | null;
  threadOf(s: SessionView | null): unknown;
  markStarted(id: string, channel: string, by?: string): void;
  defaultProject(): Promise<ProjectView | null>;
  /** sha256 hex of a string (a link guesser's bucket, a hashed sender) */
  hash(s: string): string;
  /** uniform random int in [min, max) */
  randomInt(min: number, max: number): number;
  /** random bytes as hex (a webhook secret) */
  randomHex(bytes: number): string;
  /** the scope transports hang timers on (a retry later) */
  timeout(ms: number, fn: () => void): void;
}

// ---------- commands, events, settings ----------

export const COMMANDS = {
  view: 'channels.view', // {} → GET /remote's body (read-only)
  update: 'channels.update', // PUT /remote's body → view
  test: 'channels.test', // {} → view, after a test message
  send: 'channels.send', // { msg: Msg } → { sent }   (a notice to the phone: budget, a reset, a crew note)
  notify: 'channels.notify', // { sessionId } → {}   (a reminder came due: the phone hears it too)
  act: 'channels.act', // ActArgs (no callbacks) → { line }
  inbound: 'channels.inbound', // { channel, headers, body (base64), at, dropped, verified } → { status, body }
  routed: 'channels.routed', // the grid's routed message → { status, body }
  rotate: 'channels.rotate', // { channel } → { status, body }
  extra: 'channels.extra', // { channel, what } → transport.extra(what) (read-only)
  refresh: 'channels.refresh', // {} → {}   a transport module contributed (or went off): the hub picks it up and restarts
} as const;

export const EVENTS = {
  changed: 'channels.changed', // {}   Settings should look again
  started: 'channels.started', // { sessionId, channel, by? }   a task began from a channel
} as const;

/** One switch per integration, all off by default (manifest `contributes.settings`). */
export const enabledKey = (channel: string): string => `channels.${channel}.enabled`;
export const SETTINGS = {
  events: 'channels.events', // json: ['waiting', 'finished']
  acceptChannels: 'channels.acceptChannels', // v1 defaults.acceptChannels: 'on' takes routed tasks
} as const;

/** The topic Settings → Notifications watches. */
export const TOPIC = 'channels';
