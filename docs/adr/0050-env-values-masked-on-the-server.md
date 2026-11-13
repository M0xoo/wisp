# ADR-0050: .env values are masked on the server, before any row or answer leaves it

- Status: accepted
- Date: 2026-11-13
- Source: the owner's security regression report ("v2 masks .env values only in the browser, so real values still
  leave the server through sync, share pages, peers, the grid, MCP and the CLI; v1 masked on the server"); v1
  `server/env-mask.js` and `test/env-mask.test.js`. With ADR-0003 (everything is a plugin), ADR-0005 (sync), ADR-0008
  (capabilities), ADR-0027 (shares).

## Context

v1 masked what a task shows of a `.env` / `.env.*` file on the server: a command's output when it read one, the edits
wisp captured to one, a code or diff block about one, Changes' git rows. The page got `KEY=••••`, and Reveal asked the
server for one item (`GET /sessions/:id/unmasked`). v2 ported only Changes' git rows (wisp-git `core/mask.rs`) to the
server; the transcript steps, the answer blocks and the no-git Changes were masked by the page (`@wisp/ui`
`content/env-mask.ts`). Every `turn` and `event` row therefore left the server with the values in it: on the sync
stream (the app, `wisp attach`, peers, a grid box's tunnel), in `runtime.turns` / `runtime.activity` (MCP tools, the
CLI, share bundles), and in the answer's raw text (`answer` column, `text` events), which v1 never masked either.

## Decision

1. **One rule set, sans-IO, in a base crate:** `crates/wisp-envmask` (new; deps `serde_json`, `regex`, both already in
   the workspace) ports v1's rules: `is_env_file`, `mask_line`/`mask_text`, `mask_edit` (` (changed)`), `names_env_file`,
   `mask_diffs`, `mask_block`, `mask_on` (the setting). wisp-git re-exports it for Changes; `tools/check` holds it to
   rust-sans-io. One fix over v1: a CRLF line (`K=v\r`) loses its value (v1's `.` stopped at `\r` and kept the line).
2. **wisp.runtime owns the shapes** (`wisp_runtime_core::env_mask`, pure): a step (`output` when its file, command or
   label names a .env file; a `tool_output` when flagged `env`; a `text`'s wisp blocks), a turn (its blocks with
   `masked: true`, its captured changes with `masked: true`, its raw answer text), a row (`turn`: body and `answer`;
   `event`: body), one patch op by where it lands. Every function reads only the JSON it is given.
3. **A `tool_output` says it is a .env file's text:** the turn machine remembers the calls that named one
   (`Head::env_calls`) and sets `Activity::ToolOutput.env` (additive, always written), so the stream can mask an
   output row without reading the call it answers. A row from before the flag (no `env` key) is decided by its call
   when the batch it leaves in holds it (`RowView::rows`, `mask_steps`), else by its text: every line `KEY=value`.
4. **A new kernel point, `kernel.egress` (`RowView`, additive):** a plugin views its own kinds' rows on the way out.
   wisp-api's sync stream passes every snapshot, resume and window row and every committed change (upsert, append,
   patch op values) through its owner's view (`egress.rs`, `StoreSnapshots::with_views`, `feed_viewed`). wisp.runtime
   contributes one for `turn` and `event`. The store is never touched.
5. **Reads and events answer masked, and fail closed:** the in-process `turn.activity` event's steps are masked
   before it is emitted (a sink or `events tail` never sees a value); a masking round trip that fails is an error,
   never the value as it is.
   **Reads:** `runtime.turns`, `runtime.activity`, `runtime.presentation` and `wisp_session` mask unless
   the setting is off. `runtime.turns` / `runtime.activity` take `masked: true` (additive) to mask whatever the
   setting says: wisp.share always passes it, so a share bundle (a share page's content) never carries a value.
6. **Reveal is a command:** `runtime.unmasked {id, turnId, step | block | file}` answers that one item as the store
   has it, and only a masked one (anything else is `not_found`). Its permission `runtime:unmasked` is in the `capped`
   list (a capped agent is refused, in v1's words) and in no share-page set (`preview` has no `runtime:*`); `uiOnly`
   (an agent reads the file itself). The page keeps what Reveal brought for the tab's life; Hide drops it.
7. **The setting:** Settings → Privacy → Hide .env values (`git.maskEnvFiles`, on unless `false` / v1's `'off'`) now
   governs every view, read where it is used (a flip applies to the next row; no restart).
8. **The page keeps its mask as the second layer** (an older server or a peer's rows), recognises a server-masked item
   (`masked: true`, or `••••` in a step's output) and shows the masked text until Reveal's answer arrives.

No new wire message: the stream's frames are unchanged, only their values. The new command and point are additive.

## Edge cases (each has a test)

- Empty and huge inputs: an empty text, a 20k-line file, a 2000-block turn — `huge_and_empty_inputs`,
  `empty_and_huge_turns`.
- Random .env files never keep a value and masking twice changes nothing more —
  `property_no_value_of_a_random_env_file_survives_and_masking_is_idempotent`.
- Templates (`.env.example`, `.env.sample`) and other files as they are —
  `is_env_file_takes_env_and_env_star_not_the_templates_v1_cases`,
  `a_turn_masks_its_blocks_changes_and_answer_text_and_keeps_templates_v1_mask_session`.
- Windows: a backslash path (`C:\app\.env.test`) and a CRLF file — `a_crlf_env_file_loses_its_values_v1_kept_them`.
- A command whose output is a .env file's, flagged across two events (`tool` then `tool_output`) —
  `the_turn_machine_flags_the_output_of_a_call_that_read_a_env_file`, `a_tool_output_is_masked_when_the_turn_machine_flagged_it`.
- The answer's raw text, including a broken wisp block that names a .env file (hidden whole) —
  `an_answer_texts_env_blocks_are_masked_and_a_broken_block_naming_one_is_hidden_whole`.
- A `tool_output` stored before the flag: its call in the same page or snapshot decides, else a text that reads like a
  .env file goes — `an_output_stored_before_the_flag_is_decided_by_its_call_in_the_batch_or_else_by_its_text`.
- A patch op on a turn or event row, at every depth (deeper than a block or change: every string masked) —
  `a_patch_op_is_masked_by_where_it_lands`.
- A sync topic, live and from a snapshot, and every read (turns, activity, `wisp_session`), and a share bundle —
  `a_sync_topic_a_share_and_every_read_never_carry_a_env_value_and_reveal_shows_one` (the real binary, a replayed
  Claude run that `cat`s and edits `.env`).
- Reveal gives back only a masked item, without the file from before (rollback's), and an unknown item is not found —
  `reveal_gives_the_stored_item_back_and_only_a_masked_one_v1_unmasked`.
- Capped callers and share pages are refused Reveal; a capped agent still reads (masked) turns —
  `reveal_is_refused_to_a_capped_agent_and_a_share_page`.
- The setting off: the app sees values, a share still doesn't — the serve test's last part;
  `the_setting_is_on_unless_switched_off`.
- Reveal while the value is on its way, Hide before it arrives (dropped), a refused Reveal (the line goes back to
  hidden with a toast) — `ADR-0050: a step the server masked …`, `ADR-0050: a block the server masked …` (UI tests),
  `ADR-0050: a revealed .env file the server sent masked …` (no-git Changes).
- Peers and the grid: a peer reads another machine's rows through that machine's own stream and commands, so its
  rows were masked there; a grid box's tunnel is the edge. Restart: masking holds no state; the `env` flag is on the
  stored row.
- Frontends: the app (masked, Reveal), the TUI and `wisp attach` (the stream: masked, no Reveal), the CLI and MCP
  (reads: masked), a share page (masked always, no Reveal).

## Consequences

- One more pass over every `turn` / `event` row the stream sends; it looks only at a handful of fields and allocates
  only when it masks (`runtime.*` reads round-trip through JSON only when masking is on).
- A plugin that needs a value it masked uses `runtime.unmasked` (or reads the file); nothing reads values from a row.
- The page's mask (`@wisp/ui` `env-mask.ts`) stays, as the second layer; it is no longer what keeps a value private.
