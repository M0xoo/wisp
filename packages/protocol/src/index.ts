// The sync protocol (ADR-0005, plan §4.3): one schema, shared by the server, every client and every
// peer. Carried as SSE events on GET /api/events?topics=…&cursor=… (Last-Event-ID = seq), commands
// by POST /api/cmd with an Idempotency-Key. Ops are JSON Patch (RFC 6902).
//
// Compatibility (plan §7.3.2): adding a field, message, command or topic is fine; removing or
// changing one needs PROTO + 1. tools/check diffs this file's exported shapes against
// protocol/snapshots/*.json, the last released versions.

export const PROTO = 2; // v1 was the untyped broadcast stream
export const PROTO_MIN = 2;

export type Topic =
  | 'list'
  | 'config'
  | 'crew'
  | 'machines'
  | 'stuff'
  | `session:${string}`
  | `plugin:${string}:${string}`;

/** RFC 6902, the subset wisp emits. Paths are JSON Pointers into the entity. */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'test'; path: string; value: unknown };

/** One entity change inside a patch frame. `e` is the entity kind ('session', 'turn', 'event', …). */
export type EntityOp =
  | { topic: Topic; e: string; id: string; op: 'upsert'; v: unknown }
  | { topic: Topic; e: string; id: string; op: 'patch'; ops: PatchOp[] }
  | { topic: Topic; e: string; id: string; op: 'del' }
  | { topic: Topic; e: string; id: string; op: 'append'; v: unknown[] };

export interface PeerInfo {
  peer: string;
  name: string;
  build: string;
  version: string;
  proto_min: number;
  proto_max: number;
  /** what this peer offers: features come from the peer, not the version number */
  plugins: { id: string; version: string; commands: string[]; topics: string[]; blocks: string[] }[];
}

// ---------- client → server ----------

export interface Hello {
  t: 'hello';
  proto_min: number;
  proto_max: number;
  client_id: string;
  build: string;
  epoch?: string;
  cursor?: number;
}
export interface Sub {
  t: 'sub';
  topic: Topic;
  since?: number;
  /** a passive subscription never counts as use of a box (plan §7.2.3) */
  passive?: boolean;
}
export interface Unsub {
  t: 'unsub';
  topic: Topic;
}
export interface Window {
  t: 'window';
  req: string;
  topic: Topic;
  before_seq: number;
  limit: number;
}
export interface Mutate {
  t: 'mutate';
  mid: string; // uuidv7, the idempotency key
  cmd: string; // 'session.followUp'
  args: unknown;
  base_seq?: number;
}
export type ClientMessage = Hello | Sub | Unsub | Window | Mutate;

// ---------- server → client ----------

export interface Welcome {
  t: 'welcome';
  epoch: string;
  head_seq: number;
  oldest_seq: number;
  /** false: the client must drop its caches for this peer and take snapshots */
  resume: boolean;
  proto: number;
  peer: PeerInfo;
}
export interface Snapshot {
  t: 'snapshot';
  topic: Topic;
  seq: number;
  rows: { e: string; id: string; v: unknown }[];
  more?: boolean;
}
export interface Patch {
  t: 'patch';
  seq: number;
  ops: EntityOp[];
}
export interface Rows {
  t: 'rows';
  req: string;
  rows: { e: string; id: string; v: unknown }[];
  done: boolean;
}
export interface Ack {
  t: 'ack';
  mid: string;
  seq: number;
  result?: unknown;
}
export interface Reject {
  t: 'reject';
  mid: string;
  code: string;
  message: string;
}
export interface Resync {
  t: 'resync';
  topic: Topic;
}
export interface Notice {
  t: 'notice';
  kind: string; // 'toast' | 'finished' | 'reminder' | plugin-defined
  data: unknown;
}
export type ServerMessage = Welcome | Snapshot | Patch | Rows | Ack | Reject | Resync | Notice;

/** Same envelope for the HTTP fallback of a command: POST /api/cmd {cmd, args} + Idempotency-Key. */
export interface CommandRequest {
  cmd: string;
  args: unknown;
}
export type CommandResponse = { ok: true; seq: number; result?: unknown } | { ok: false; error: { code: string; message: string; retry?: boolean } };

export function isTopic(s: string): s is Topic {
  return s === 'list' || s === 'config' || s === 'crew' || s === 'machines' || s === 'stuff' || /^session:[^\s]+$/.test(s) || /^plugin:[a-z0-9.-]+:[a-z0-9._-]+$/.test(s);
}

export { applyPatch, deepEqual, diff, escapePointer, parsePointer } from './json-patch.ts';
