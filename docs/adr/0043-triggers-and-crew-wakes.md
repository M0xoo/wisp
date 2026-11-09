# ADR-0043: Triggers are one engine with pluggable sources; crew members wake on any of them

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "work more on crew members and triggers, to have more options on how we trigger tasks or crew
  members' work". Builds on ADR-0026/0028 (the `trigger` kind), ADR-0040 (meet users where they work) and
  ADR-0042 (every feature behind a point).

## Context

v2 has two trigger implementations side by side, and that's a code smell:
- `wisp.automations` ports v1's 8 kinds (`schedule`, `ci`, `issues`, `finished`, `done`, `webhook`, `slack`,
  `linear`) with its own row type (`TriggerBase`). The kind list is hard-coded (`TRIGGER_KINDS`).
- The `trigger` resource kind (`plugins/automations/host/src/trigger.rs`) only runs `finished` and `webhook`.

Crew members wake on their `cron`, on jobs sent to them, and on `on: [finished, done, ci]` (`MEMBER_KINDS`).
Nothing else can wake them, so a crew member can't react to a PR review request, a chat message, a failing test
in your terminal, or another member's report.

## Decision

### 1. One engine, sources as a point

- `wisp.automations` owns **one trigger engine**. The `trigger` resource kind is the only declaration: the UI,
  the CLI, the MCP tools and formulas all write the same spec. `TriggerBase` becomes the engine's row (state
  only: last run, deliveries, cursor); the hard-coded kind lists go.
- **`trigger.source@1`** is a point. A source declares its `on` names, the JSON Schema of its fields (for the
  editor, `wisp trigger add --help` and formula validation), and how it gets events: `push` (it calls the
  engine) or `poll` (the engine calls it every `every`, with backoff). It emits **`TriggerEvent { on, key,
  at, payload, summary }`**. `key` is the dedupe key.
- Each source lives in the plugin that owns the data. The engine names no service (no `if on == "github"`).

### 2. Sources

| `on` | Owning plugin | Fields | Notes |
|---|---|---|---|
| `schedule` | automations | `cron` or words ("every weekday at 9"), `tz`, `jitter` | v1 parity; tz from ADR-0025 |
| `once` | automations | `at` | a one-off later (later's engine) |
| `task.finished`, `task.done`, `task.held`, `task.failed`, `task.asked` | runtime | `project`, `agent`, `crew`, `tag`, `by` | `held`/`failed`/`asked` are new |
| `goal.failed`, `goal.met` | goal | `goal` | a judge's verdict |
| `crew.reported` | crew | `member`, `match` | a member's report wakes another (hand-offs) |
| `ci.failed`, `ci.passed` | github (gh) | `branch`, `workflow` | v1 `ci` |
| `issue.opened`, `issue.labeled`, `issue.commented` | issues | `label`, `match`, `author` | v1 `issues` + comments |
| `pr.opened`, `pr.review_requested`, `pr.commented`, `pr.merged`, `pr.conflicted` | ship/review | `base`, `author`, `reviewer`, `label` | new |
| `git.pushed`, `git.committed` | git | `branch`, `paths` (globs) | local repos, through the git watcher |
| `files.changed` | worktrees | `paths`, `debounce` | in a project, not inside wisp's own worktrees |
| `chat.message` | channels (+ telegram, slack, discord, email) | `channel`, `keyword`, `users` | v1 `slack` generalised; `@member` mention routes to that member |
| `webhook` | automations | `secret`, `header` | v1 parity; generic JSON in the prompt as `{payload}` |
| `linear.issue` | connectors | `team`, `state` | v1 `linear` |
| `terminal.failed` | termctx | `match`, `cwd` | a command in a tracked shell exits non-zero (opt-in, ADR-0023) |
| `usage.reset`, `budget.freed` | budget/accounts | `account` | held work starts when the window opens |
| `machine.online` | machines | `machine` | a computer comes back |
| `manual` | automations | — | only `wisp trigger fire`, the Run button, MCP `wisp_trigger_fire` |

Any user plugin can add a source the same way (ADR-0042).

### 3. What a trigger does: target

`target` is one of these:
- `task: <spec name or inline spec>`: a new task (default; with `agent`, `model`, `mode`, `cwd`, `machine`);
- `crew: <member>`: a job for a member (its queue, its notebook, its context);
- `workflow: <name>`: run a workflow with the event as input;
- `followUp: true`: a follow-up to the task the event came from (`task.*`, `pr.*` linked to a task).

The prompt is a template. `{event.summary}`, `{event.payload.x}`, `{recipe params}` are filled in, and the event is
attached to the job as a block so the agent sees where it came from.

### 4. When it fires: conditions and flow control

- `if:` a small expression over the event and wisp state (`event.payload.branch == 'main' && !task.running`),
  the same evaluator as workflows' `if` (ADR-0028). No shell.
- `when:` windows: `days`, `hours`, `tz`, `quiet` (outside them: `skip` or `queue` until open).
- `debounce`/`batch`: events within a window become one job listing them all (ten pushes = one review).
- `concurrency`: `skip` | `queue` | `replace` (cancel the running one) | `parallel: n`, per trigger and per key.
- `rate`: at most N per hour/day. Over it: held with a reason, never dropped silently.
- `budget`: a cap per run and per day, enforced by `wisp.budget`'s guard.
- `cooldown` after a failure; three failures in a row pause the trigger and notify.
- `approval: true`: the job waits as an ask card before it starts (off by default; never in Full auto, owner rule).

### 5. Crew members

- A member's spec gets **`wakes:`**, a list of trigger specs targeting the member (sugar for triggers with `target:
  crew`). `cron` stays as a shorthand for one `schedule` wake. `on:` (v1 `MEMBER_KINDS`) is read as `wakes:` on import.
- **Mentions wake members:**
  - `@member` in a prompt, a chat message, an issue or PR comment, or a task's follow-up sends that member a job;
  - the source is recorded on the job.
- **Members trigger each other:** `crew.reported` with `match` gives you hand-offs (researcher → lead → release
  manager) without a workflow. `wisp crew graph` shows who wakes whom, and cycles are refused at apply.
- **The member decides:** a job from a wake carries `why` (the event). The member may answer `quiet` (nothing to do),
  and the trigger records it as `skipped by member`, not as a failure.
- **Per-member limits:** `parallel` (exists), `rate`, `when` (working hours) and `budget` apply to every wake of
  that member.

### 6. Everywhere (ADR-0040)

| Where | How |
|---|---|
| App | Automations pane: "When" picker grouped by source, live preview of the last 5 matching events ("would have fired"), deliveries log; crew editor "Wakes" section |
| TUI | Automations view, same picker; `f` fires |
| CLI | `wisp trigger add/ls/rm/fire/test/log`; `wisp crew wake <member> [--why]` |
| Formula | `trigger.<name>` and `crew.<name>.wakes` |
| MCP | `wisp_trigger_*`, `wisp_crew_wake` (so an outside harness can wake a member) |
| Git/CI | `wisp trigger fire <name> --payload @file` in a GitHub Action step; the webhook source |
| Chat | `@member` in any connected channel |

### 7. Dry run

`wisp trigger test <name> [--event @file | --last N]` evaluates `if`, `when`, `debounce`, `rate` and the
template against real recent events, and starts nothing. The app's preview uses the same command.

## Edge cases (one named test each)

1. `schedule_fires_once_per_minute_across_restart`: the last fired minute is persisted, so restarting in the same
   minute doesn't fire twice.
2. `missed_schedule_while_asleep_fires_once_not_n_times`: a laptop that wakes after 8 h runs the missed schedule
   once, marked `late`.
3. `dst_gap_and_overlap_fire_once`: a 02:30 run on a DST day fires exactly once in the member's tz.
4. `same_event_key_fires_once`: the dedupe key holds across polls and restarts (bounded seen-set per trigger).
5. `debounce_batches_ten_pushes_into_one_job`
6. `concurrency_skip_queue_replace_parallel`: one test per policy.
7. `rate_limit_holds_with_reason_never_drops`
8. `trigger_started_tasks_do_not_retrigger_themselves`: lineage `triggeredBy` stops `task.finished` loops.
   Cross-trigger cycles are cut at depth 3 (v1 `finished` storm).
9. `crew_wake_cycle_refused_at_apply`: A wakes B, B wakes A on `crew.reported` → plan error naming the cycle.
10. `mention_in_chat_from_unknown_user_is_refused`: `chat.message` respects `users`; an open channel needs an
    explicit `users: anyone`.
11. `webhook_secret_compared_constant_time_and_body_capped`: 1 MB cap, 413 above it.
12. `paused_member_queues_wakes_and_resume_drains_in_order`
13. `member_quiet_answer_is_skipped_not_failed`
14. `three_failures_pause_and_notify`
15. `source_plugin_off_marks_triggers_unavailable`: switching a source's plugin off leaves its triggers listed as
    `unavailable: <plugin> is off`, not deleted; on again, they resume without replaying missed events.
16. `poll_backoff_on_gh_rate_limit`: a `gh` 403 rate limit backs off to `reset`, without a failure count.
17. `approval_never_added_in_full_auto`
18. `files_changed_ignores_wisps_own_worktrees_and_gitignored`
19. `test_dry_run_starts_nothing`
20. `v1_trigger_rows_import_to_specs`: all 8 v1 kinds, including `MEMBER_KINDS` → `wakes`.
21. `budget_guard_holds_triggered_run_over_daily_cap`

## Consequences

- One trigger code path: `TriggerBase`'s kind-specific fields move into each source's schema, and the hard-coded
  `TRIGGER_KINDS`, `HOOK_KINDS`, `GH_KINDS` and `MEMBER_KINDS` go.
- Sources run in their owning plugins, so switching off `wisp.github` removes `ci.*` and nothing else.
- Polling sources share one scheduler in the engine (no timer per trigger); push sources cost nothing idle.
- Builds after the grid round; the termctx source lands with ADR-0023.
