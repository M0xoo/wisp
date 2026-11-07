# ADR-0014: The grid's control plane keeps its own SQLite file, and its trust rules are data

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9, §4.7, §7.2.4, §7.2.5

## Context

v1's grid (`grid/`) moves to `apps/grid` (`@wisp/grid`). Two things had to be decided for it.

1. **Its database.** `grid.db` is live on every grid: 26 tables (25 plus `meta`) made by 11 migrations,
   with the schema version in `meta(k, v)`. `@wisp/store` keeps per-owner versions in `meta(key, value)`
   (STRICT) and records every write in `change` for sync. The grid has no peers to sync with: its
   readers are its own edge and CLI.
2. **Who may reach what.** v1 wrote the grid's trust rules as comments in `grid/route.js`,
   `grid/inbox.js`, `grid/server.js` and `server/http/trust.js` ("a box never gets a token for a
   laptop", "x-wisp-proxy-via: inbox is only set by delivery"). ADR-0008 says they become data.

## Decision

- `apps/grid/src/db.ts` opens `grid.db` with `node:sqlite` directly, not through `@wisp/store`. It keeps
  the store's discipline: numbered migrations that only add (`migrations.ts`, the index is the
  version), each in its own transaction, a database newer than the code refused, and a `VACUUM INTO`
  copy in `backups/` before an upgrade touches a database that holds data. A live `grid.db` opens as it
  was, with no migration of its own.
- `apps/grid/src/trust.ts` holds the rules as data: a capability set per credential (`session`,
  `cookie`, `preview`, `device`, `key`, `box`, `sandbox`, `hook`, `webhook`), each an allow list of
  reaches plus denies with their reason. `may(credential, reach)` is default deny, and a deny beats
  an allow. The marks only the grid sets (`x-wisp-proxy-secret`, `x-wisp-proxy-via`, `x-wisp-route`,
  `x-wisp-preview`, `x-wisp-upgrade`, `x-forwarded-*`) are listed too. `fromOutside()` drops all of
  them from every request coming in, and `viaHeader()` refuses a via value set by the wrong source.
- The box's side of trusted-proxy mode (`boxTrust`) is written next to it as the reference that the
  grid's stand-in boxes run. The kernel's HTTP trusted-proxy option (plan §7.2.5) should match it.

## Consequences

- The grid gets no change feed and no per-owner versions. If the grid ever syncs control-plane rows to
  peers, it moves to `@wisp/store`, behind a migration from `meta(k, v)`, and a new ADR records that.
- Every credential check at the edge names a reach, so adding a route means choosing who reaches it.
  `test/trust.test.ts` pins the table. Changing a row is a deliberate act in the PR.
