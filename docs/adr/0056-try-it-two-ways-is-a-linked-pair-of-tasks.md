# ADR-0056: Try it two ways is a linked pair of tasks: a per-task variant, a `runtime.trial` command and a trial link on each run

- Status: accepted
- Date: 2026-11-14
- Source: F-comp-31 (v1 #650 "Try it two ways", #771 "+ already adds the run"): one task run twice on one harness with
  one setting changed (the subagents' model, or Skills off), side by side; Compare says what differed
  (`session.trial.differs`) and Keep marks the run you kept (`trialKept`). v2 runs had no per-task variant.

## Context

v1 kept a run's variant on its session (`subagentModel`, `skills: 'off'`), refused one a harness can't run (a
dropped one would be two identical paid runs), started the runs of one launch with `trial: true` and recorded
`session.trial = { differs, kept }`. v2 had compare runs (a shared `ext["wisp.runtime"].group`, F-comp-30) but no
variant: `HarnessRun.subagent_model` only ever came from the `runtime.subagentModel` setting and `skills` was never set,
and nothing linked two runs as one trial. Claude Code is today's only harness that runs either change
(`CLAUDE_CODE_SUBAGENT_MODEL`, `--disable-slash-commands`); the kernel and the runtime must not name it (ADR-0003).

## Decision

1. **A per-task variant (additive).** `runtime.create`'s `StartArgs` gains `subagentModel` ('' = the task's own model,
   `haiku`, `sonnet`) and `skills` (`on` | `off`). It is kept on the task as `ext["wisp.runtime"].variant` and applied on
   **every** turn (follow-ups included); the task's own `subagentModel` beats the setting, '' included. A task with a
   variant never starts as a terminal task (the CLI there wouldn't apply it); one asked as a terminal (`terminal: true`,
   a `/terminal …` prompt) is refused.
2. **A harness says what it can vary.** `HarnessInfo.variants` (additive, default empty) lists the keys it runs;
   Claude Code declares both. A start asking for a variant its harness lacks is **refused by name** ("Codex can't run
   with its skills off"), never run without it. The UI reads the same list from `HarnessUiDef.variants` (additive).
3. **`runtime.trial { task, vary }` → `{ group, runs, differs }`.** Run A is `task` as given, run B is `task` with
   `vary` applied. Both go through `runtime.create` (its hooks, permission, cap and worktree), each in a worktree of its
   own. Refused before anything runs: no harness / Auto, Plan, no project or `worktree: false`, a folder outside git, a
   terminal task, a held or scheduled start, an empty `vary`, run B the same as run A (as it would really run: A's
   subagents follow the setting), a harness without the variant. If run B is refused after run A started, run A is
   stopped and archived.
4. **The trial link (new wire shape).** Each run carries `ext["wisp.runtime"].trial` and the list row's
   `summary.trial`: `{ group, run: 0|1, runs: [A, B], differs: [{ key, values: [A's, B's] }], kept? }`; `differs` keys
   are `subagentModel` and `skills` (`on`/`off`). The row also carries `summary.variant` and `summary.groupId` (so
   Compare runs shows the pair, F-comp-30).
5. **`runtime.trial.keep { id }`.** Every run of the trial says which one you kept (`trial.kept`); the kept run is
   unarchived, the others stopped (a run still working would go on billing out of sight) and archived. Idempotent; keeping the other one later swaps them. A sibling deleted meanwhile is
   skipped. Deleting the other run's worktree stays the UI's explicit step (`worktrees.clean`), as for any compare.
6. **Reach (ADR-0040).** Both commands are MCP tools (generated from the catalogue) and reachable by `user:full`,
   agents and API keys through `runtime:*`; a pane is refused `runtime:trial` like `runtime:create`. In wisp: the run
   added with **+** on the lead's harness offers *Subagents* and *Skills* in its menu; Compare shows what differed under
   the ask and each run's change in its column; each row's run line leads with its change.

## Edge cases (each with its test)

| Case | Test |
| --- | --- |
| Run B differs by one setting, both in worktrees | `trial::tests::a_trial_is_run_a_as_given_and_run_b_with_one_setting_changed_both_in_worktrees_v1_try_two_ways` |
| A's subagents follow the setting; the same as the setting is refused | `trial::tests::run_as_subagents_follow_the_setting_so_differs_says_what_really_ran_v1_trial_differs` |
| Auto, Plan, no project, in place, held, scheduled, terminal, empty vary refused | `trial::tests::a_trial_is_refused_on_auto_in_plan_without_a_project_in_place_held_or_in_a_terminal_v1_try_refusals` |
| A harness without the variant refuses it by name | `trial::tests::a_variant_a_harness_cant_run_is_refused_by_name_never_dropped_v1_check_variant`, `tests/trial.rs` `a_harness_without_variants_refuses_one_by_name_and_starts_nothing_v1_check_variant` |
| The variant reaches the harness on every turn; '' beats the setting | `tests/trial.rs` `a_tasks_variant_reaches_its_harness_on_every_turn_and_its_own_pick_beats_the_setting_v1_try_two_ways` |
| Keep marks both, archives the other, swaps on a second keep, refuses a plain task | `tests/trial.rs` `keep_this_marks_the_kept_run_on_both_and_archives_the_other_v1_trial_kept` |
| A variant on a terminal task is refused | `tests/trial.rs` `a_variant_on_a_terminal_task_is_refused_never_dropped_v1_terminal_variant` |
| Keep stops the other run still working | `tests/trial.rs` `keep_stops_the_other_run_still_working_so_it_stops_billing_out_of_sight` |
| Both rows carry the link and B its variant | `group::tests::both_runs_of_a_trial_carry_the_link_and_their_variant_on_the_row_v1_try_two_ways` |
| End to end: two worktrees, `--disable-slash-commands`, subagent env, list rows, Keep, refusals (folder outside git included) | `crates/wisp/tests/serve_trial.rs` |
| The UI: the menu, the trial the launch sends, words, run order, optimistic rows and Keep | `packages/shell/test/trial.test.ts`, `plugins/shell-list/ui/test/run-line.test.ts` `a_trial_runs_line_…` |

## Consequences

- A new harness that runs a variant only declares it in `HarnessInfo.variants` and `HarnessUiDef.variants` and reads
  `HarnessRun.subagent_model` / `skills`; nothing else changes.
- The two runs are written by two `runtime.create` transactions plus one link edit each, not one transaction: a crash
  between them leaves run A with a link whose `runs` is empty (Keep still works on it alone).
- Not ported: v1's CLI `--try`, the Ask-near-the-limit sum of a launch's runs (`together`), and the `try_two_ways`
  telemetry count; each is its own job.
