// @wisp/sync: topics, cursors, per-connection outboxes and SSE framing (ADR-0005, plan §4.3–§4.5).
// Sans-IO: every machine here is `handle(input, now) → outputs`. The only I/O is `./node-sse.ts`,
// which apps/server imports by its own path so a browser bundle never pulls in node:http.

export { SyncServer } from './server.ts';
export { toEntityOp } from './rows.ts';
export { SyncClient } from './client.ts';
export type { SyncClientOptions, SyncClientSaved } from './client.ts';
export { Outbox, topicRank } from './outbox.ts';
export { compose, fold } from './fold.ts';
export { applyEntityOps, applySnapshot } from './apply.ts';
export type { EntityMap } from './apply.ts';
export { EVENT, SseParser, decodeFrame, encodeFrame, heartbeat, retryField } from './sse.ts';
export type { SseEvent } from './sse.ts';
export { parseClientMessage, parseHello } from './parse.ts';
export type * from './types.ts';
