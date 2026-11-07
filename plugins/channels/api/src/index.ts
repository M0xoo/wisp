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
import type { ActArgs, ActionKind, ChannelCtx, Msg, Phone, ProjectView, Remote, SessionView, Signed, Thread } from './views.ts';

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
  /**
   * Its on switch: a bool setting, off by default, declared in the module's own manifest
   * ('telegram.enabled'). Absent: 'channels.<name>.enabled'. The hub reads cfg.enabled from it.
   */
  setting?: string;
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

export type * from './views.ts';

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

/** A transport's on switch (TransportDef.setting): every integration ships off. */
export const enabledKey = (channel: string): string => `channels.${channel}.enabled`;
export const switchOf = (d: Pick<TransportDef, 'name' | 'setting'>): string => d.setting ?? enabledKey(d.name);
export const SETTINGS = {
  acceptChannels: 'channels.acceptChannels', // v1 defaults.acceptChannels: 'on' takes routed tasks
} as const;

/** The topic Settings → Notifications watches. */
export const TOPIC = 'plugin:wisp.channels:remote';
