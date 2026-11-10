# v1 items v2 drops on purpose

Only the owner or an ADR drops a v1 feature (docs/v2-queue.md, "the default is to keep it"). ADR-0031 drops v1's
compatibility surface (routes, event names, dual-write, v1 peers), never a feature's intent: those rows map to the
v2 piece in `docs/v2-coverage.md`. What's listed here has no intent left to serve. The `v1-coverage` check reads
this table: a v1 item in neither file is an error.

| kind | v1 | why |
|---|---|---|
| setting | `agentBeforeAuto` | v1's one-time migration memo (the pick before Auto became the default, store.js:170); v2 imports the pick itself (`wisp import`, ADR-0031) |
| setting | `view` | already gone in v1: the layout switch was removed and store.js deletes the saved value (split view is the only layout) |
