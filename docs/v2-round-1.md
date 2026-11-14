# v2 round, item 1: events + triggers (ADR-0044, ADR-0043)

ADR-0044 (durable events) landed last round (46e5bbcd..3c32f2d3). This section covers ADR-0043 on top of it.

## Built

**One engine (`wisp.automations`)**
- `core/src/engine.rs`, sans-IO:
  - `admit`, `gate`, `flush`, `drain`, `started`, `ended` and `next_poll`;
  - `in_window`, `availability`, `dry_run` and `fill`.
- `core/src/schedule.rs`: due minutes on the local wall clock, with a 7-day lookback.
- `host/src/engine.rs` runs the decisions:
  - each trigger's state row is `automations_trigger_state` (migration 2), replacing v1's `TriggerBase` bookkeeping;
  - one decision at a time;
  - it starts the target (task, prompt, crew, workflow or followUp), stops a replaced run, and emits `trigger.fired` (durable).
- `host/src/trigger.rs`:
  - the `trigger` kind now uses `wisp_automations_api::TriggerSpec`, checked at plan;
  - the webhook route has a 1 MB cap (413) and the same 404 for every refusal;
  - one durable subscription (`on_durable_any("engine", "*")`) handles every durable type, plus run outcomes (`task.finished`, `task.failed`, `crew.reported`);
  - a 15 s tick runs schedules, once, debounce flushes, queues and polls.
- The hard-coded kind lists are gone. v1's kinds live only in `api/src/v1.rs`, for import.

**Contract additions**
- automations api:
  - `trigger.source@1` (`TriggerSource`: `ons`, `poll`);
  - `trigger.provider@1` (`TriggerProvider`: triggers declared inside another plugin's spec);
  - `TriggerFired`;
  - the commands `automations.trigger.{ls,fire,test,log,push,approve,resume}` and `automations.sources`.
- Manifests may list `contributes.triggerSources` (the `on` names a plugin offers). That's how a trigger whose source plugin is off is still known and marked unavailable.
- Kernel, additive: `Ctx::plugin_status()` and `Ctx::contributions_by(point)`.
- channels api: `Phone::heard(channel, sender, text)`, with a no-op default.

**Sources**
- runtime: `task.finished`, `task.failed`, `task.held`, `task.asked`, `task.done` (durable).
- goal: `goal.met`, `goal.failed`.
- crew: `crew.reported`, with `quiet` read from the job's crew block.
- machines: `machines.online` is now durable.
- github: `ci.failed` and `ci.passed`, a poll of `gh run list` through proc. A 403 rate limit becomes `retry_at` from `gh api rate_limit`.
- issues: `issue.opened` and `issue.labeled`, a poll through the picker's own lister. A folder path is accepted as the project.
- worktrees: `files.changed`, a poll of `git status --porcelain -z` through proc.
- channels: `chat.message`, pushed from `converse`, with `trusted` for `@mention` wakes.
- automations itself: `schedule`, `once`, `webhook`, `manual`.

**Crew**
- A member's `wakes:` reaches the engine as `crew.<handle>.<n>` triggers, with the member's pause, mode and `parallel`.
- Commands: `crew.wake`, `crew.wakeMentions` and `crew.graph`.
- A cycle is refused at plan (`check_all` → `wake_loops`).

**Everywhere else**
- CLI: `wisp trigger add/ls/rm/fire/test/log/resume/approve/sources` and `wisp crew wake/graph` (`crates/wisp/src/trigger_cli.rs`).
- MCP: tools are generated from the catalogue (`automations_trigger_*`, `crew_wake`, `crew_graph`).
- Formula: `trigger.<name>` and `crew.<name>.wakes`.
- v1 import: `v1_formula.rs` maps every kind through `from_v1`, and a member's `on` becomes `wakes`.
- `agent:session` may now use `automations:read` (list and dry-run, not fire).

**ADR-0043's 21 named tests: all written.** These were run one at a time and pass:
- 1–8, 10, 12–14, 16, 17 and 21, plus 15 and 19: `plugins/automations/core`;
- 9 `crew_wake_cycle_refused_at_apply`: `plugins/crew/host/src/kind.rs`;
- 11 `webhook_secret_compared_constant_time_and_body_capped`: `plugins/automations/host/src/trigger.rs`;
- 18 `files_changed_ignores_wisps_own_worktrees_and_gitignored`: `plugins/worktrees/core/src/changes.rs`;
- 20 `v1_trigger_rows_import_to_specs`: `plugins/automations/api/src/v1.rs`.

Also new:
- `when_windows_read_days_and_hours`;
- `ci_runs_past_the_cursor_become_events` and `a_rate_limit_is_told_from_a_failure`;
- `new_issues_and_new_labels_fire_once`;
- `trigger_add_reads_its_flags_into_a_spec`;
- a CI cursor fix found while writing the poll: a run still in progress no longer hides its later failure.

Clippy `-D warnings` is clean on every touched crate. `npm run check` reports 0 errors.

## What's left

- **Decisions to confirm:**
  - "Full auto" is read as `mode: auto` set explicitly on the trigger, or a member whose mode is `auto`. A trigger with no mode can still ask for approval, even though the runtime's default mode is `auto`.
  - A `chat.message` mention wakes the crew only when the channel marks the sender `trusted`.
- **Approval** waits in the trigger's state (`awaiting`, `automations.trigger.approve`). It's not yet an ask card in the inbox.
- **Push sources not wired yet:**
  - `chat.message` fires only once the transports call `converse`. They're item 4's port.
  - `issue.commented`, `pr.review_requested`, `pr.commented`, `pr.conflicted`, `git.pushed`, `git.committed`, `linear.issue`, `usage.reset`, `budget.freed` and `terminal.failed` (item 3) have no source yet. A trigger on one shows as "no plugin offers …".
- **`files.changed`** is a poll of `git status` (every minute by default), not a file watcher. A watcher needs a new dependency (`notify`), so it needs its own ADR.
- **`budget.perRun`** is checked as a spec field but not enforced. `wisp.budget`'s guard isn't wired to triggered runs yet.
- **MCP tool names** are the generated `automations_trigger_*`, not ADR-0043's `wisp_trigger_*`.
- **UI** (the Automations "When" picker, deliveries and the crew Wakes section) comes with the GUI, item 7.
- **Tests:** only the single tests above were run. The host engine has no integration test with a kernel yet; PR CI runs the suites.
