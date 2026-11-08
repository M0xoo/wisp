# ADR-0019: OpenAPI is checked on the Rust route table, not by a static rule

- Status: accepted
- Date: 2026-11-08
- Source: verify round 1 (docs/v2-verify-log.md #26).

## Context

`tools/check/rules/openapi.ts` read HTTP routes statically from `apps/server/src`: v1's Node server.
v2 deleted it (ADR-0013), so the rule found no routes and checked nothing, while still counting as a
passing gate. The v2 edge (`crates/wisp-api`) builds `/api/openapi.json` at run time from its route table
(`openapi::document(edge.table().list())`), which holds the edge's own routes and every route a plugin
added through `kernel.http`. Plugins build routes through helper functions (`route(cell, "POST", path,
perm, summary, handler)`), so a static scan of Rust sources would miss most of them.

## Decision

1. The `openapi` rule is retired: it is no longer in `tools/check/rules/index.ts`'s `RULES`. Its file and
   tests stay, marked retired, in case a static registry comes back.
2. The check moves to where the table is: `crates/wisp/tests/serve_task.rs` starts the real `wisp serve`
   with every plugin of the build (DefaultPlugins) and reads `/api/openapi.json`. Every operation must
   have a non-empty `summary`, and runtime's and the edge's routes must be listed. `doc: false` still
   hides a route on purpose.

## Consequences

- A route without a summary fails `cargo test -p wisp` (and so `npm test` and CI), not `npm run check`.
- Routes are documented by construction: a route can't be added without going through the table the
  document is built from. What isn't checked is a route's request and response shapes (the document says
  `schema: {}`); that needs ts-rs types on routes, a later decision.
