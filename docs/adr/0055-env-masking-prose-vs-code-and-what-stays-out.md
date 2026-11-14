# ADR-0055: .env masking tells prose from code, keeps ranges at write for every plugin row, and masks the reads

- Status: accepted
- Date: 2026-11-14
- Source: round 163's bug (a watch page's script `MAX=10;` went out as `MAX=••••;` and the page broke) and the owner's
  round-164 brief: "for HTML and code mask only the task's known values … store ranges at write time for learn, later,
  history and stuff rows … mask the stuff and later list commands and their MCP tools … what stays out and why".
  Supersedes ADR-0054's *Not covered yet* list (the rest of ADR-0054 stands). Extends ADR-0050.

## Context

ADR-0054 masked other plugins' data about a task as it leaves through `runtime.envmask@1`. Round 163 added views for
`watch` / `watch_page`, learn, later, history and stuff rows. Three things were wrong or missing:

1. **Code was masked as prose.** Every string of a watch's rows went through the .env-line rule
   (`KEY=value` alone on a line), the page's HTML included. A script line `MAX=10;` or `X=1` matched it, so the page
   reached the browser as `MAX=••••;` and its script threw. The same rule ran on a turn's `code` and `diff` blocks
   about a `.js` or `.ts` file.
2. **Only `goal_run` and the watch rows kept ranges at write.** A learn retro or list, a later entry or plan, a
   history request, or a stuff item sent before its task's values were back in memory (the first snapshot after a
   restart) was hidden whole (`••••`), even where it quoted nothing.
3. **The reads answered rows unmasked.** `later.list`, `later.plans`, `later.getPlan`, `stuff.list`, `stuff.get`,
   `stuff.find` and `stuff.describe` returned what was stored, and so did the MCP tools over them (each command is one, and `wisp_stuff`). The sync rows were masked but these reads were not.

## Decision

### What is masked where

| Data | Where it leaves | Rule |
| --- | --- | --- |
| A task's turns, events and row (ADR-0050) | `session:<id>`, `runtime.*` reads, shares, MCP | ADR-0050 rules (unchanged), with the code rule below for answer blocks |
| A turn's other `ext` slots and its prompt (ADR-0054) | the turn row and reads | ADR-0054 (unchanged) |
| `goal_run` (ADR-0054) | `session:<id>` | prose, ranges kept at write (`turn.envHide`) |
| `watch` (title, caption, state, run) | `session:<id>` | prose (free JSON), ranges kept at write (`body.envHide`) |
| `watch_page` `html` | `session:<id>` | **code**, ranges kept at write (`body.envHide`) |
| `learn.retro` (title, error, added/removed texts) | `plugin:wisp.learn:lists`, `learn.view`, `learn.retro` | prose against the retro's task, ranges kept at write (`body.envHide`) |
| `learn.list` items a retro in memory added | `plugin:wisp.learn:lists`, `learn.view`, `learn.set` | prose against that retro's task, ranges kept at write per item (`body.envHide["/lessons/3"]`), with each item's task (`envHide["#by"]`: a list is written while its retro runs, before that retro is in the history) |
| `later_entry` text, `later_plan` title/text/prompt, `later_meta` reminder | `plugin:wisp.later:later`, `later.list`, `later.plans`, `later.getPlan` | prompt (values only), ranges kept at write (`body.envHide`) |
| `history_request` why and title | `plugin:wisp.history:requests`, `history.requests` / `.resumeRequest` / `.resumeAnswer`, the chat notice | prose against the task that asked (or the one it names), ranges kept at write (`body.envHide`) |
| `stuff_item` / `stuff.item` (title, note, excerpt, tags, source, from.title, prev.excerpt) | `stuff`, `stuff.list` / `.get` / `.find` / `.describe`, `wisp_stuff` | prose against `from.session`, ranges kept at write (`from.envHide`, both tables) |
| A stuff file's text in `stuff.describe` / `wisp_stuff` | the agent | values only (code or a doc) |

### Prose and code

1. **Prose** is what an agent writes for a person to read: an answer's markdown, a reason, a title, a note, a watch's
   state. Prose gets the task's known values (and their JSON-escaped forms) **and** the .env-line rule, so an unknown
   value on a `KEY=value` line is still caught.
2. **Code** gets the task's known values (and their JSON-escaped forms) only, never the .env-line rule. Code is a
   watch page's HTML and its script (`watch_page.html`, `/body/html` patches), a `code` or `diff` answer block not
   about a .env file, and a stuff file's text.
3. A `code` / `diff` block counts as code when its `file` (or `path`) is not a .env file, or, when it names no file,
   when its `language` is not one a .env file is shown in (`env`, `dotenv`, `sh`, `bash`, `zsh`, `shell`, `console`,
   `ini`, `properties`, `conf`, `text`, `txt`, `plaintext`, or none). A block naming neither keeps the prose rule
   (fail closed). A block about a .env file keeps its own rules (ADR-0050: masked whole, flagged for Reveal).
4. Nothing known and no ranges still hides code whole, as it does prose (fail closed).

`env_other::mask_free(v, kept, known, code)` takes the code pointers. `env_session` walks a code block's fields under
the key `#code`, which never gets the line rule.

### Ranges at write, for every plugin row

`wisp-runtime-api::env` gets `keep`, `carry`, `take_kept`, `kept_of` and `mask_prompt_kept` (all additive). They
work like `goal_run`'s: as a row is written, each text gets the ranges of the values its task read (`EnvMask::ranges`,
offsets only) under `envHide`. A send that has nothing in memory masks by those ranges and by the rules that need no
value, instead of hiding the row whole. A text whose task isn't in memory as it is written gets no ranges. `carry`
then copies the ranges the stored row had for that text, if the text is unchanged. This covers stuff's view rows, which
are all rewritten at start, and a later or list rewrite after a restart. The ranges never leave: every view takes them
out, even with Hide .env values off.

### The reads

`later.list`, `later.plans` and `later.getPlan` answer each row masked as its sync row is. So do `stuff.list`,
`stuff.get`, `stuff.find` and `stuff.describe`. `stuff.find` matches the masked item, so a search for a hidden value
finds nothing. Commands are MCP tools through the catalogue, so their tools answer masked too;
`wisp_stuff` formats from masked items. `history.requests` now reads the stored bodies, so it masks by their
ranges.

### What stays out, and why

- **`crew_member.notebook`.** It belongs to no one task: a crew member's notes come from many tasks, so there are no
  "values its task read" to mask against. The .env-line rule is the only thing that could run there, and on its own
  it would rewrite a member's code notes as round 163 rewrote scripts. Until a notebook entry records the task it came
  from, it leaves as written.
- **Learn list items the user edited, or whose retro aged out of the history (`MAX_HISTORY`).** No retro in memory
  added that text, so it has no task. It keeps the .env-line rule only. An edited item is the user's own words. An
  aged-out item was masked by its retro's ranges while that retro was kept.
- **A plugin reading another plugin's slot with `runtime.get`** still gets it as stored (`SESSION_OWN`, ADR-0054): it
  may write it back.
- **The raw answer text (`Turn.text`)** keeps ADR-0050's raw-prose rule, code blocks inside its JSON included. The
  page draws from the presentation, which follows the code rule. The raw text is only shown by Reveal and copy.
- **A patch that lands on a code field by path** (`…/blocks/2/code`) has no block around it to say it is code, so it
  keeps the prose rule. Answers are written whole, so no such patch is sent today.

## Edge cases (each has a test)

- A page's script `const MAX=10;`, `MAX=10;` and `X=1` survives, a known value in it is masked (also JSON-escaped),
  prose beside it keeps the line rule, a `/body/html` patch is code, ranges work after a restart, and nothing known
  hides it: `a_pages_script_keeps_its_key_value_lines_and_loses_only_the_tasks_known_values` (runtime core). Run with
  the old all-prose path, it fails on `"\nMAX=10;\n" survives`.
- The same, end to end, on the task's topic in a snapshot and in the first snapshot after a restart:
  `a_watch_pages_script_keeps_its_key_value_lines_and_loses_only_the_value_the_task_read` (serve_envmask).
- A watch page live and after a restart, its script intact:
  `a_watch_and_its_page_quoting_a_value_the_task_read_leave_masked_live_and_after_a_restart_by_their_ranges`
  (runtime host).
- Code blocks by file and by language, a diff of a `.js` file, a block naming neither (line rule), a `bash` block
  (line rule), and markdown beside them (prose):
  `a_code_block_not_about_a_env_file_loses_only_the_tasks_values_and_prose_keeps_the_line_rule` (runtime core).
- Later: an entry and a plan masked by their ranges after a restart, an old row hidden whole, a rewrite carrying
  ranges, a changed text losing them, and the list commands masked or hidden without the service:
  `a_follow_up_and_a_plan_keep_their_ranges_at_write_and_their_list_answers_are_masked`.
- History: a request's why by its ranges, read back as a request, carried on approval:
  `a_resume_requests_ranges_kept_at_write_mask_it_after_a_restart_and_never_leave`.
- Learn: a retro and the items it added by their ranges, a list sent while its retro still runs (by the task kept
  with it), the user's own item by its lines, a list rewrite carrying:
  `a_retro_and_the_items_it_added_keep_their_ranges_at_write_and_mask_after_a_restart`.
- Stuff: an item by its ranges in `from`, carried at a start-up rewrite, a changed note losing them, and the reads
  (item, file text values only, list, hidden without the service, your own upload as it is):
  `an_items_ranges_kept_at_write_mask_it_after_a_restart_and_its_reads_answer_masked`.

## Consequences

- An unknown value on a `KEY=value` line inside code (a page's script, a JS code block) is no longer caught. Only the
  values the task read are. This trade is deliberate: the line rule cannot tell `MAX=10` from `API_KEY=…` in code, and
  breaking the user's page is a visible bug every time.
- Each plugin row is a little larger: one pointer→ranges map, offsets only. A write does one `EnvMask::ranges` call
  per text (a memory lookup and a scan per value) and one `get` of the row it replaces, inside the same transaction.
- `learn.view` and `later.list` answer from memory, where rows carry no ranges. On their first call after a restart a
  quoting text is hidden whole while its task's values are read back (as ADR-0054's goal reads were).
- No new wire message, kind or column. The service API, the `testing::EnvFake` stand-in and the `envHide` keys are
  additive.
