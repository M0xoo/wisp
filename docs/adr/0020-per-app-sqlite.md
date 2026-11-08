# ADR-0020: A launched app keeps its own SQLite file, outside wisp's store

- Status: accepted
- Date: 2026-11-08
- Source: verify round 3 (docs/v2-verify-log.md #R3-7).

## Context

v1 gave an app in My Stuff a database of its own when its `wisp-app.json` says `"db": true`
(server/app-db.js): the app reaches it on its own origin (`/_wisp/db`), as `sql(query, ...params)`. That data
is the app's (a todo list, a form's entries, a game's scores), not wisp's: the user can reset it, it is
removed with the app, and a published copy on the grid has a database of its own. It isn't something a wisp
client subscribes to, and its schema is whatever the app's seed made.

wisp's rows go through wisp-store, one write path recorded in the change feed (ADR-0004). Putting an app's
tables in `wisp.db` would mix code wisp doesn't control into wisp's own transactions and change feed, give the
app's SQL a way to reach wisp's rows, and make "reset this app's data" a migration.

## Decision

1. **A new kind of state: an app's own database.** It is one SQLite file per app,
   `<home>/stuff/<id>-data.sqlite`, owned by wisp.stuff (`plugins/stuff/host/src/appdb.rs`). It is not in the
   change feed and no client subscribes to it; the app reads and writes it through `/_wisp/db` only.
2. **The limits are v1's:** no `ATTACH`, `PRAGMA`, `VACUUM`, `load_extension` or `sqlite_dbpage` in the app's
   SQL (`wisp_stuff_core::appdb::allowed_sql`); a size cap (`max_page_count`, 100 MB); a 5 s limit per query
   (SQLite's interrupt); the seed runs once, and a seed stopped halfway is redone (`PRAGMA user_version`).
   Queries run on tokio's blocking pool.
3. **`rusqlite` in wisp-stuff** is allowed for this file only (the workspace already pins it for wisp-store).
   Everything else My Stuff keeps (items, uploads, contents) is in wisp-store (`stuff_item`, `stuff_upload`,
   blobs).

## Consequences

- Removing an app or resetting its data deletes or empties that file; wisp's store is untouched.
- Backups of `wisp.db` don't include apps' data; the app files sit beside it under `<home>/stuff`.
- A second kind of database file in a plugin needs its own ADR.
