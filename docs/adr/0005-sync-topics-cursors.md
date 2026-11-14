# ADR-0005: Sync: topics and cursors over the existing SSE, commands by POST

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 broadcast every event, unfiltered, to every client, with the full summary row each time. There was no backpressure, and the phone hashed the whole list on every request.

## Decision

- `@wisp/protocol` holds the wire types, shared by the server, every client and every peer. `PROTO = 2`.
- Transport: `GET /api/events?topics=…&cursor=…` (SSE, `Last-Event-ID` = seq) and `POST /api/cmd` with an `Idempotency-Key`. No WebSocket: over HTTP/2, SSE plus POST gets past the tunnel's six-connection limit.
- `@wisp/sync` is sans-IO: deterministic machines for the server (per-connection outbox, coalescing, priorities, backpressure → `resync`) and the client (a cursor per (peer, epoch), refcounted subs, pending commands resent after `welcome`). Only `node-sse.ts` touches sockets.
- Ops are JSON Patch (RFC 6902). There is no generic replay: each client command declares its own optimistic patch.
- Compatibility: a client supports `proto_max-2 … proto_max`. Adding is free; removing or changing a field bumps `PROTO`. `tools/check` diffs the types against released snapshots. Features come from `welcome.peer.plugins`, never from version checks.

## Consequences

Clients never poll. Every peer (another computer, a grid box) speaks the same protocol, so the relay that rewrote ids in v1 is gone: ids carry their origin (`<peer>:<uuid>`).
