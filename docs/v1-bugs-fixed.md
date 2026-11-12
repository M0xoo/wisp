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
| Reruns | a rerun ran on today's code, so "rerun" didn't reproduce what was asked | every task records its base commit; `wisp rerun` starts from it (a detached worktree) unless `--from latest` | `crates/wisp/tests/serve_code.rs` (the rerun's HEAD is the first commit) |
| Setup | a schedule written in words was stored as a cron, so re-saving the same words looked like a change | each kind normalizes before planning: the same words plan as unchanged | `serve_code.rs` (applying twice: 6 unchanged) |
| Import | `wisp import` (v1 home) applied without showing what it would change | it shows the plan first (as a formula), applies on yes; history is imported apart | `crates/wisp/tests/serve_code.rs` (`--dry-run` changes nothing) |
| Sharing | a shared task only scrubbed secret shapes: home paths, env values and other tasks' names went out | the preview lists every redaction (secrets, secret env values, paths, names) and nothing leaves without yes | `plugins/share/core` tests, `serve_code.rs` |
| Fork | forking a task with turns failed its foreign key: turns were written before their new session (found in v2's own port) | the session is written first in the same transaction | `serve_code.rs` (fork of an imported share) |
| Worktrees | a task asked for a worktree (`worktree: true`, a project's default) ran in the folder itself: the runtime recorded the flag and never made one (found in v2's own port) | the runtime makes it through `worktrees.create` before the first turn; the project's setup runs there only, and a failure holds the turn with why (v1's held card) | `crates/wisp/tests/serve_kinds.rs` (`setup-ran.txt` in the worktree, not the folder; `a_failing_setup_holds_…`) |
| Connectors | `RunPart::mcp_servers` was declared but the runner never called it, so a declared connector reached no run (found in v2's own port) | the runner asks every `runtime.run@1` part for its MCP servers each turn | `crates/wisp/tests/serve_kinds.rs` (`docs` in `--mcp-config`) |
| Project trust | `ctx.untrusted` was always false: a repo's hooks and MCP servers ran even where its trust said no (found in v2's own port) | a project that declares trust without hooks or MCP runs with the harness's untrusted flags; its setup runs only when trusted | `serve_kinds.rs` (`--setting-sources`) |
| Automations | a trigger on "finished" and a review pipeline could start each other forever (found in v2's own port) | neither acts on a task a trigger or a pipeline started | `plugins/automations/host/src/trigger.rs`, `plugins/router/host/src/pipeline.rs` tests, `serve_kinds.rs` (3 tasks, then nothing) |
| Channels | a member whose name starts another's (`@Ada` and `@Ada Lovelace`) matched inside it, at the same place, so `@Ada Lovelace, @bob: …` addressed only Ada Lovelace and left Bob in the task text | a name can't match inside a longer one already found | `plugins/channels/core/src/mentions.rs` `a_leading_mention_addresses_the_member_and_the_rest_is_the_task` |
| Auto | (found in v2's own port) `runtime.create` on `agent: "auto"` ran the first harness: no plugin provided `router.service@1` and the router learned from nothing | the runtime asks Auto, keeps the route on the task, and the router learns from launches, overrides, turn ends and limits | `plugins/runtime/host/tests/lifecycle.rs` `a_task_on_auto_runs_on_the_routers_pick_and_teaches_it`, router `service::tests` |
| Crew | (found in v2's own port) nobody contributed `runtime.outcome@1`, so a crew job's crew block never decided where it landed (a quiet check-in landed in Review, unread) | crew files its jobs (quiet, For later, Done); a quiet one with a follow-up scheduled is filed, not archived (v1 #760) | `wisp_crew::tests::a_quiet_check_in_keeps_its_scheduled_follow_up` |
| Stats | (found in v2's own port) Claude reports its per-model tokens as a list; the turn's stats read only a map, so every Claude turn lost them | the list is kept, keyed by model | `wisp_runtime_core::cold` tests read them |
| Projects | Found on this machine listed each repo twice on a case-insensitive disk (`~/code` and `~/Code` are one folder; the v1 reference screenshot shows `kilocode ~/code` and `kilocode ~/Code`), and a project reached by the other spelling still showed as found | each repo once, by the folder as the disk names it; a known project is known whichever spelling found it | `found::tests::repos_on_this_computer_that_arent_projects_yet_are_found` |
| Projects | adding a folder that was already a project made a second one | that folder is already <name>, said, nothing added | seen in Chrome (round 17) |
| Folder suggestions | `GET /fs?q=` read a path that wasn't absolute against the server's own working folder (typing `code/` listed wisp's install folder) | `runtime.folders` answers only for `~` or absolute paths, in the form typed | `plugins/runtime/host/src/found.rs` `a_typed_path_suggests_the_folders_it_could_go_on_to_v1_fs` |
| Panes | a task a pane started took your saved defaults, Full auto included | a pane's task always starts on Edits | `plugins/stuff/ui/test/pane-host.test.ts` `a task a pane starts goes out on Edits whatever mode it carries_never_full_auto` |
| Phone Crew section | — (found in v2: an opened report under a member left both its member and Needs you while open) | the list and the member agree on one rule: under the member until it needs you | `plugins/shell-list/ui/test/crew.test.ts` `…leave the list until they need you_v1_under_member` |

- **Settings → Worktrees on a phone squeezed each task's name to one letter** (v1 .wtr-row kept four fixed columns at any
  width). v2's `SettingsItem` puts the name and its line on their own line under 520px, the state, size and buttons under
  it. Test: kit settings `v1_settings_pieces_render_their_parts_and_the_flags_their_css_reads` (the parts); seen at 390.

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
