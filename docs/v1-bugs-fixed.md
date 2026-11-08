# v1 bugs fixed in v2

Each line: area · what v1 did · what v2 does · the test. Visible changes are also in
`design/v1-reference/allowed.md`. See `docs/v2-port-intent.md`.

| Area | v1 | v2 | Test |
|---|---|---|---|
| UI bars | toolbars and the top bar wrapped onto a second line ("Full auto", the memory chip) | bars fold label → icon → More (ADR-0012) | `qa/layout.mjs` |
| UI feedback | some actions showed nothing until the server answered | every action answers within one frame (ADR-0017) | `qa/feedback.mjs` |
| Runtime | a question asked before a restart couldn't be answered after it (found in v2's own port; v1 kept it in the store) | asks persist and stay answerable | `crates/wisp/tests/serve_task.rs` restart mid-ask |
| Permissions | — | "Always allow" covers only the same action | runtime approval tests, `serve_task.rs` `always_allow_…` (a different command still asks) |
| Agent tokens | an agent's token checked per route; `/api/cmd`-style calls and wisp's MCP tools could name another task | the kernel checks every command's task args (`Command::TASK_ARGS`), at every depth, and every route's task params, against the agent's task and its children (`wisp_kernel::scope`) | `crates/wisp-testkit/tests/scope.rs`, `serve_task.rs` `an_agents_token_cannot_touch_another_task` |
| Harness watch | `harnesses.json` written in place (`writeFileSync`): a crash mid-write left it unreadable, the next start reset every pin, and a swapped program was then pinned as trusted | pins and changes are store rows, written in a transaction | `serve_accounts.rs` `a_changed_harness_holds_its_turn_until_trusted` |
| Accounts | a new account's id was made by the server, so the row the page showed at once wasn't the one kept | the client's id is the account's id | `serve_accounts.rs` (`id: "w1"`) |
| Telemetry | any key a caller passed was sent | only the catalogue's keys go; an unknown one is dropped | `plugins/telemetry/host/tests/sinks.rs` |
| Questions | a question left open when its turn ended stayed on the task in review, and a reply after a restart still answered it | the question goes with its turn (v1 runner.js:1812 did this; v2's port had missed it) | `serve_task.rs` `a_question_open_when_its_turn_ends_is_cleared` |
| Terminal | a Stop while a terminal started could race the start, an ended terminal reopened its dead screen, a slow start said nothing (v1 #435, #432, #440) | the flow machine of plan §4.6.3 drives every terminal: a Stop cancels the start, an ended one starts fresh, a slow start says so | `plugins/terminal/core` flow tests, `serve_terminal.rs` |
| CLI | `wisp "task"` printed only the title, so a script couldn't follow the task it started | it prints the id and `wisp attach <id>` (and a terminal stays attached) | `crates/wisp/tests/serve_cli.rs` `generated_verbs_…` reads the id back |
| CLI | `wisp show` printed a block type it didn't know as JSON | every block has a terminal renderer; an unknown one shows its title and "update wisp to see this" | `plugins/cli/core/tests/goldens.rs` (no line starts with `{`) |
| CLI | `wisp ls` said "— asks:" on every row once the summary carried an empty question (found in v2's own port) | only a real question shows | `crates/wisp/tests/serve_cli.rs` |

## Decided by the lead (2026-11-08; the owner asked not to be stopped for these)

- **Agents reading other tasks: allowed, read-only.** `wisp_sessions` / `wisp_session` are a v1 feature
  agents rely on (the lead itself uses them), so that's intent, not a bug. An `agent:session` token may
  **read** any task through those two tools. It may **write** (follow up, rename, archive, stop) only its own
  task and its children. A capped task (`agent:capped`, channel-started below Full auto) reads only its own
  task and children. The kernel scope keeps writes as they are and allows the two read commands, with tests.
- **Times in later: stored as UTC, shown in the user's local time.** The client sends its time zone (IANA)
  with the settings, and later parses and formats in it. Until a client has sent one, the server's local
  zone is used, as in v1. Not a bug fix, so nothing to list above.

## Questions for the owner

(none open)
