# Backend round 2: the v1-coverage check, and the gaps it found

## The check: `v1-coverage` (tools/check)

- `tools/check/rules/v1-coverage.ts`, registered in `tools/check/rules/index.ts` (after `ui-commands`).
- Inputs (committed, because v1 is deleted at cutover):
  - `docs/v1-routes.txt` (304 routes, already there);
  - `docs/v1-surface.txt` (new, generated once from v1's `server/` and `bin/wisp.js`): 35 MCP tools,
    29 CLI commands (grid's sub-commands included), 55 `defaults.*` setting keys, 48 telemetry events.
- `docs/v2-coverage.md` (469 rows): each v1 item → the v2 refs that serve it. Ref kinds: `cmd:`, `setting:`,
  `kind:` (resource kind section), `mcp:`, `cli:`, `route:`, `telemetry:` (in the catalogue **and** emitted by
  some non-test Rust), `ui:` (client-only state, with where), `todo:` (work).
- `docs/v1-dropped.md` (2 rows: `agentBeforeAuto`, `view`; both already dead in v1).
- Errors: a v1 item in neither table; a row for no v1 item; a row both mapped and dropped; two rows for one item;
  a ref that names nothing. `todo:` rows: one warning with the count.
- Test: `tools/check/test/v1-coverage.test.ts` › `v1-coverage: an unmapped v1 item, a reference to nothing, an
  event nobody emits and a stale row fail; todo rows warn` (ran alone: pass).
- Now: `node tools/check/index.ts --rule=v1-coverage` → **0 errors, 1 warning (69 todo)**, 236 ms.
- `docs/v2-coverage.md` is the source from here on: edit its rows by hand as gaps close (the one-time generator
  was a scratch script, not committed).

## Gaps built this round

### Auto wasn't wired at all (found by the sweep)

`runtime.create` with `agent: "auto"` (or none) silently ran the first harness; nobody provided
`router.service@1`, and the router's learning (`wisp_router_core::auto::apply`) was never called.
- `plugins/router/host/src/service.rs` (new): `Svc` provides `router.service@1` (`pick`: level-up first, then
  `choose` over the harnesses of the last look; `classify`: `limit_of`; `report`: `auto::apply`, then save).
  `learn`: a durable `turn.ended` subscriber (`router_learns`): a limit cools the arm and voids the run, else the
  first end's error/cost is a signal. `State.here` caches the harnesses each view/preview reads.
- Runtime: `Host::router()` (additive, default `None`; `CtxHost` uses the service, `Recorder.router` for tests).
  `Runtime::auto_pick` on create; the route kept at `ext["wisp.router"].route`; `auto_learn` reports
  `Launched`, or `Manual` for your own top-level pick, plus `Override` when `StartArgs.auto_override` (new,
  additive, v1 `autoOverride`) says Auto's preview showed another. No router on: the first harness, as before.
- Manifests: router `provides: router.service 1.0.0`, + `telemetry:track`; runtime + `router:read`, `router:write`.
- Tests: `lifecycle::a_task_on_auto_runs_on_the_routers_pick_and_teaches_it`,
  `service::tests::auto_learns_from_a_routed_tasks_turn_end_and_cools_at_a_limit`,
  `service::tests::an_override_and_a_settled_auto_launch_count_as_telemetry` (all pass).

### Telemetry events nobody emitted (22 → 7, each left one a `todo:` row)

| event | emitted by |
|---|---|
| `fork_task`, `exec_action`, `run_app` | runtime (`plugin.rs`: `track()`, the Fork/Exec/ProjectRun handlers) |
| `agent_launch`, `agent_task`, `crew_tool`, `connector_tool` | mcp (`wisp_mcp_core::telemetry::of`, after a tool call that worked; test `tool_calls_count_as_their_catalogue_events`) |
| `crew_imported`, `crew_shared` | crew (`transfer.rs`) |
| `worktrees_brought_in` | worktrees (`bring_in`) |
| `takeover` | terminal (`terminal.open` of the take-over kind) |
| `task_share`, `task_import` | share (`share.create`, `share.import`) |
| `auto_override`, `auto_settled` | router (`service.rs`, on `report`) |

`telemetry:track` added to the mcp, crew, worktrees, share and router manifests. Left (the feature isn't built):
`spell_hook`, `spell_installed`, `side_task`, `move_task`, `retro`, `try_two_ways`, `channel_event` (chunk 3).

### Bindings

`cargo test -p wisp-runtime-api export_bindings` (125 ok): `runtime/AutoOverride.ts`, `runtime/StartArgs.ts`.

### The `harness == "claude"` branch in runtime/setup.rs

- `Harness::skill_dirs(cwd) -> Vec<(PathBuf, label)>` (additive, default empty) in `wisp-runtime-api`.
- `setup::available` takes the dirs; `run.rs::record_setup` asks the task's harness. wisp.runtime names no harness.
- `plugins/claude/host/src/lib.rs`: Claude's `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `.claude/skills`.
- Test: `wisp_claude::tests::claude_names_the_skill_folders_it_loads_by_itself` (pass).
- Also dropped the `s.agent != "claude"` I had put in `cold::compact_offer` (round 1): only a harness that
  reports its cache TTL reaches it.
- **Left, same smell in other plugins** (not in this item): `worktrees/host/src/trust.rs:86`
  (`agent == "claude"` → Claude's trust items) and `budget/core/src/windows.rs:160` (dollars for Claude). Both
  want a harness point (trust items, the unit a plan's window counts in).

### Update relaunch

- `Updater::hand_off(pid)` (update core): `sh -c 'sleep 1; kill -TERM <pid>; wait until it's gone (≤ 30 s);
  <relaunch_command>'`, only once the install is done; `None` on Windows. The desktop app reopens, a browser tab
  is kept (same port).
- Host (`relaunch`): spawns it detached through the proc service (`proc:exec{bin:sh}` already granted); `next`
  says "wisp restarts on <v> now", else the old "Restart wisp …".
- Test: `updater::an_installed_update_relaunches_wisp_through_a_detached_waiter` (pass).
- SIGTERM lands in `serve::until_signal`, wisp's clean stop (every plugin off, the store closed).

### Learn (v1 preferences.js): the scaffold was empty

- `wisp-learn-api`: `Kind`, `Lists`, `Change`, `Retro`, `View`; commands `learn.view` (read-only), `learn.set`
  (v1 PUT /preferences), `learn.retro` (run one now); setting `learn.enabled` (v1 `defaults.learn`).
- `wisp-learn-core` (sans-IO): `clean`, `merge` (a retro's proposal over the edits you made while it ran),
  `prompt_block`, `digest` (newest turns kept within 10 000 chars), `worth_retro`, `parse_retro` (bare or fenced
  JSON; a left-out list stays), `retro_prompt`.
- `wisp-learn` host: tables `learn_list`, `learn_retro` (last 30), `learn_seen` (how far each task was read);
  `runtime.prompt@1` part (the block, for the task's project: its worktree's `root`, else its folder);
  the retro scheduler: `turn.ended` done/stopped (not interrupted) → 90 s wait, cancelled by the next
  `turn.started`; one retro at a time; the run is `runtime.quick` on the task's own harness; every run logged
  and counted as `retro` telemetry.
- Tests: core `a_list_is_trimmed_deduped_and_capped_newest_first`, `a_retro_merges_over_edits_you_made_while_it_ran`,
  `later_prompts_carry_what_was_learned_and_nothing_when_empty`, `a_one_shot_task_that_just_worked_teaches_nothing`,
  `the_digest_keeps_the_newest_turns_and_says_how_each_ended`, `a_retro_reply_is_read_bare_or_fenced_and_a_left_out_list_stays`;
  host `a_worktree_task_learns_for_its_main_checkout`, `a_turn_reads_its_commands_failures_questions_and_report`,
  `manifest_is_valid` (all pass). Clippy clean on the three crates.
- Differences from v1, on purpose: the retro runs on the task's harness at its default model through
  `runtime.quick` (lean, plan mode), not v1's hard-coded Haiku (no harness is named outside its plugin).
- **For the UI coder:** Settings → Learning (v1's pane): the lists by scope with edit/remove (`learn.set`), the
  recent retros (`learn.view.history`), the on/off switch (`learn.enabled`).

## For the UI coder

- The launcher sends `autoOverride: {key, type}` with a harness you picked after Auto's preview showed `key`.
- The task card can show `ext["wisp.router"].route` (why Auto picked it: `why`, `chance`, `usd`).

## Checks run

- `cargo clippy -p wisp-router -p wisp-runtime -p wisp-runtime-api -p wisp-crew -p wisp-mcp -p wisp-mcp-core
  -p wisp-share -p wisp-terminal -p wisp-worktrees --all-targets -- -D warnings`: clean; then `-p wisp-runtime
  -p wisp-runtime-core -p wisp-claude` and `-p wisp-update-core -p wisp-update`: clean.
- `node tools/check/index.ts --rule=v1-coverage`: 0 errors, 1 warning.

## Still todo (69 rows in docs/v2-coverage.md)

In progress below as they land.
