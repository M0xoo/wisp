# ADR-0054: other plugins' data about a task is .env-masked as it leaves, through one runtime service

- Status: accepted
- Date: 2026-11-14
- Source: the owner's security brief (round 162: "other plugins' slots in a turn's or task's `ext` written from agent
  text … goal's verdict, crew answers, learn's retro digest, review findings, ship/PR text"). Extends ADR-0050; with
  ADR-0003 (built-ins get no private API).

## Context

ADR-0050 masks a task's own text on the way out: its turns, events, and its task row (whose `ext` covers every
plugin's slot). Three ways round it were left open:

1. **A turn's `ext`.** Only wisp.runtime's slot was masked (`changes`, `blocked`). Another plugin's slot written
   from agent text (`runtime.turn.setExt`: wisp.crew's `answers[].answer`) left as stored.
2. **Another plugin's own kinds.** `goal_run` (a judge's `why`, and its `turn`: prompt, `text`, `activity`) goes out
   on `session:<id>` with no view. The judge runs in the task's folder, so it can read `.env` itself and quote it.
   This was proven by `a_goal_judges_verdict_quoting_a_value_the_task_read_reaches_no_topic_read_or_share`, which
   failed on `goal_run.turn.text`.
3. **A turn's prompt.** A plugin writes agent text into it: a goal's next round quotes its judges' `why`. The same
   test failed there second.

## Decision

1. **`runtime.envmask@1` (new service, wisp-runtime-api `env`):** `EnvMask::mask(task: Option<&str>, v: &mut Value)`.
   It needs no call and does no IO. It does nothing when Hide .env values is off. Otherwise it runs, in order:
   - the .env step rules on `v.activity`;
   - a raw `v.text` masked as raw answer text (its .env blocks, and values escaped inside its JSON);
   - a `v.prompt` masked against the values only;
   - every other string checked against the values the task read plus every .env-shaped line.

   Two cases hide all of `v`'s text instead (a step's `callId` and `tool` stay, so outputs still pair with their
   calls): the task's values are not in memory (they are read back once, in the background, for the next send), or
   `task` is `None`. wisp.runtime
   provides it (manifest `provides`). Any plugin uses it the same way, built-ins included.
2. **A plugin views its own kinds through `kernel.egress`, using the service.** wisp.goal contributes `RunView` for
   `goal_run`: `why` and `turn` go through `mask`. A patch can't name its task, so its text is hidden; records are
   upserted, so none is sent. If wisp.runtime is off, the record's text is hidden (fail closed).
3. **A turn's other slots** (`ext.*` except `wisp.runtime`) are prose (`env_other`):
   - `env_turn::hide_of` keeps their ranges in `body.envHide` and writes `#ext` (the ranges hold the slots), so a row
     sent after a restart still masks them.
   - A row from before `#ext` is scanned against what is known, and its task's values are read back for the next
     send. With nothing known yet, its agent-text keys (`answer`, `text`, `why`, …) are hidden and .env-shaped lines
     are masked in the rest (a rating or an app's state stays).
   - A row written while its values couldn't be read (`envHide: "unread"`) hides its slots and prompt whole.
   - A patch into a slot is masked by where it lands.
   - A `#clean` row without `#ext` that has other slots is no longer skipped.
4. **A turn's prompt** (body and column) is masked against the task's known values only, never by a line's shape:
   `DEBUG=1` is the user's. A new row keeps the prompt's ranges. A patch with nothing known hides it. A `#clean` row
   from before `#ext` is scanned when its task's values are known.

No new wire message. Everything is additive: the service, the `#ext` key, and goal's view.

## Edge cases (each has a test)

- A judge reads `.env` and votes `NOT MET` quoting the value. Its record, live and in a snapshot, carries no value
  (masked, not dropped), and neither do `runtime.get`, `runtime.turns` or a share. The next round's prompt doesn't
  either: `a_goal_judges_verdict_quoting_a_value_the_task_read_reaches_no_topic_read_or_share` (serve_envmask).
- The judge's own `.env` output, its answer's `.env` code block, a .env line and an escaped PEM value inside the
  raw answer's JSON, the goal prompt's own `DEBUG=1`, and unknown values (hidden whole, steps still paired); masking
  twice changes nothing more:
  `another_plugins_text_is_masked_against_the_tasks_values_and_hidden_whole_when_they_are_unknown`.
- A task not in memory (hidden, then read back), and no task named:
  `another_plugins_text_is_masked_against_its_tasks_values_in_memory_and_hidden_while_they_are_read_back` (runtime
  host).
- A goal record without wisp.runtime (hidden), and a running record (as it is):
  `a_check_records_why_and_answer_go_through_the_tasks_mask_and_are_hidden_without_it` (goal host).
- A turn's crew answer by its ranges with nothing known; one from before `#ext`, scanned, or with its answer hidden
  and its rating kept; an `unread` row hidden whole; wisp.runtime's slot untouched:
  `a_turns_other_slots_are_masked_by_their_ranges_or_scanned_and_runtimes_own_slot_keeps_its_rules`.
- A `#clean` row from before `#ext` with a crew answer quoting a value is looked at, and a clean row written now
  leaves unscanned: `a_turn_row_with_a_crew_answer_leaves_masked_and_a_clean_row_from_before_still_has_its_slots_looked_at`.
- Patches into a slot, the whole `ext`, wisp.runtime's own slot, and a non-slot path:
  `a_patch_into_another_slot_masks_by_where_it_lands`.
- A prompt a plugin wrote: its values masked, the user's own `KEY=value` lines kept, a patch with nothing known
  hidden: `a_prompt_a_plugin_wrote_from_agent_text_loses_the_tasks_values_and_keeps_the_users_own_lines`.

## Not covered yet

Each of these gets a view through the same service when it is done:

- `watch` / `watch_page` (runtime's own; agent HTML).
- `learn.retro` / `learn.list` (task-tied; `plugin:wisp.learn:lists`).
- `later_entry` / `later_plan`, `history_request`, `stuff_item`.
- `crew_member.notebook` (not tied to one task: only .env-shaped lines can be told there).

Two more gaps:

- A plugin that reads another plugin's task slot with `runtime.get` gets it as stored (`SESSION_OWN`).
- A prompt on a turn row from before `#ext` leaves as it is on the first send after a restart. Its task's values
  are read back for the next send.

## Consequences

- A turn with only wisp.runtime's slot and a clean prompt costs one map lookup more. A row written now with other
  slots is masked by its ranges, with no scan.
- A `goal_run` record sent before its task's values are back in memory (the first snapshot after a restart) shows
  `••••` for its text until the record is sent again.
