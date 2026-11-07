// @wisp/sync (client side): the sans-IO SyncClient, SSE framing and the client's apply rules
// (ADR-0005, plan §4.3–§4.5). The server half lives in Rust (crates/wisp-sync); both sides share the
// wire types in @wisp/protocol, checked against the Rust goldens.

export { SyncClient } from './client.ts';
export type { SyncClientOptions, SyncClientSaved } from './client.ts';
export { compose, fold } from './fold.ts';
export { applyEntityOps, applySnapshot } from './apply.ts';
export type { EntityMap } from './apply.ts';
export { EVENT, SseParser, decodeFrame, encodeFrame, heartbeat, retryField } from './sse.ts';
export type { SseEvent } from './sse.ts';
export { parseClientMessage, parseHello } from './parse.ts';
export type * from './types.ts';
