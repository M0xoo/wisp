# v1 bugs fixed in v2

Each line: area · what v1 did · what v2 does · the test. Visible changes are also in
`design/v1-reference/allowed.md`. See `docs/v2-port-intent.md`.

| Area | v1 | v2 | Test |
|---|---|---|---|
| UI bars | toolbars and the top bar wrapped onto a second line ("Full auto", the memory chip) | bars fold label → icon → More (ADR-0012) | `qa/layout.mjs` |
| UI feedback | some actions showed nothing until the server answered | every action answers within one frame (ADR-0017) | `qa/feedback.mjs` |
| Runtime | a question asked before a restart couldn't be answered after it (found in v2's own port; v1 kept it in the store) | asks persist and stay answerable | `crates/wisp/tests/serve_task.rs` restart mid-ask |
| Permissions | — | "Always allow" covers only the same action | runtime approval tests |

## Questions for the owner

(none yet)
