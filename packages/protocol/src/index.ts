// The sync protocol (ADR-0005, plan §4.3): one schema, shared by the server, every client and every
// peer. Carried as SSE events on GET /api/events?topics=…&cursor=… (Last-Event-ID = seq), commands
// by POST /api/cmd with an Idempotency-Key. Ops are JSON Patch (RFC 6902).
//
// The wire types are Rust's (crates/wisp-protocol, ADR-0013), generated into ./generated/protocol.ts
// by `cargo test -p wisp-protocol export_bindings`: never edit that file by hand.
//
// Compatibility (plan §7.3.2): adding a field, message, command or topic is fine; removing or
// changing one needs PROTO + 1. tools/check diffs the exported shapes against
// protocol/snapshots/*.json, the last released versions.

export const PROTO = 2; // v1 was the untyped broadcast stream; crates/wisp-protocol checks this matches
export const PROTO_MIN = 2;

export type {
  Ack,
  ClientMessage,
  CommandError,
  CommandRequest,
  CommandResponse,
  EntityOp,
  Hello,
  Mutate,
  Notice,
  Patch,
  PatchOp,
  PeerInfo,
  PeerPlugin,
  Reject,
  Resync,
  Row,
  Rows,
  ServerMessage,
  Snapshot,
  Sub,
  Topic,
  Unsub,
  Welcome,
  Window,
} from './generated/protocol.ts';

import type { Topic } from './generated/protocol.ts';

export function isTopic(s: string): s is Topic {
  return s === 'list' || s === 'config' || s === 'crew' || s === 'machines' || s === 'stuff' || /^session:[^\s]+$/.test(s) || /^plugin:[a-z0-9.-]+:[a-z0-9._-]+$/.test(s);
}

export { applyPatch, deepEqual, diff, escapePointer, parsePointer } from './json-patch.ts';
