# ADR-0004: Store: node:sqlite with a change feed and one write path

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 rewrote a whole session's JSON every 400 ms while it streamed: 538 MB written for one 2 MB session, against 19 MB in SQLite (plan §2.3). Every session also stayed in memory.

## Decision

- `@wisp/store` on `node:sqlite`: WAL, STRICT tables, foreign keys, prepared statements.
- **One write path:** `store.tx(fn)`. Every entity op (upsert, patch, del, append) writes its row and a `change` row (RFC 6902 patch) in the same transaction. Listeners hear only committed changes. That feed drives sync, history and plugin subscriptions.
- Activity is an append-only event log; everything else is plain rows. Plugins own their tables, under their own prefix, with forward-only migrations tracked per owner. A `VACUUM INTO` snapshot is taken before an upgrade.
- Mutations are idempotent per `(client_id, mid)`. Blobs go in a content-addressed store (sha256, as `node:crypto` has no BLAKE3; the hash name is kept in the row), compressed with zstd: inline up to 64 KB, in files above that.
- Retention: change rows for 7 days or 1M rows, mutation rows for 24 h. The epoch rotates on restore and import.
- v1's `~/.wisp` is imported in the background, resumable by (file, mtime, size). For one release the JSON files are written too (the downgrade path, plan §4.8). `secrets.json`, login folders, crew files and worktrees stay files.

## Consequences

Gate G1 (`spikes/store-bench`) holds the numbers. A grid box gets one database per tenant for free, because each box runs its own server.
