# ADR-0051: A task's topic is a window: its latest 8 turns whole, older ones as stubs, and a change to a stub goes as the stub

- Status: accepted
- Date: 2026-11-13
- Source: v1 #788 (54b25972, "a long task with many subagents opens fast": latest 8 turns whole, 68 MB → 2.4 MB);
  `docs/v1-sync.md` row #788. With ADR-0004 (one write path, the change feed), ADR-0005 (sync: topics, snapshots,
  resumes), ADR-0011 (performance budgets), ADR-0050 (`kernel.egress`: every row leaves through its owner's view).

## Context

A task's topic (`session:<id>`) had no snapshot source, so its first look was read from the change feed
(`changed_since(topic, 0)`): every row of every change the task ever had, each event append with its rows. A seeded
lead of 257 turns × 40 events with 52 subagents sent **20.1 MB** on each first look (the app's task page, `wisp
attach`, the TUI); v1 had the same problem at 68 MB and fixed it in #788 by sending only the latest 8 turns whole.
Almost all of that is old turns' events (tool output) and their captured edits (`ext["wisp.runtime"].changes`), which
nobody looks at until they unfold the turn; the folded row and the usage card need a few fields.

The first port left one gap: a live change to an older turn (a late rating, a checkpoint, an edit appended) went out
as the store's diff, which a client holding the stub can't take. The diff replaces whole arrays and inserts missing
keys, so it either fails (`add /body/ext/wisp.runtime/changes/-`: the stub has no `changes`), which made the client
resync the topic and re-download the whole window, or it applied and left a hybrid (a stub with the answer, the text
and every block in it).

## Decision

1. **A task's topic is a window** (`wisp_runtime_core::turn_window`, pure; `wisp_runtime::turn_window`, the reads):
   its full snapshot is the task's row, its queue, setup and watch, every turn row (oldest first), and the events of
   only the latest `WHOLE_TURNS` = 8 turns. Older turns are **stubs**; their events are never read from disk. A task
   of 8 turns or fewer goes whole.
2. **A stub** is the turn row without `answer`, its `body` cut to: `stub: true`; `id, sessionId, idx, prompt, agent,
   model, effort, account, mode, attachments, by, status, startedAt, endedAt, held, stats, isError, changedFiles,
   refusal, limit, nEvents` when present; every plugin's `ext` but runtime's edits (`ext["wisp.runtime"].changes`), so
   Fork, the checkpoint and ratings still work; `presentation.blocks` reduced to the hero's `type, title, summary,
   status`, plus a Compact now turn's (`by: "compact"`) first markdown block, which is what its folded row says. The row's
   columns (`id, session_id, idx, status, started_at, ended_at, prompt`) stay.
3. **Four topic names**, all under the task's `session:` grammar (no new wire message; `topic:read` decides who reads
   each, as for `session:<id>`):

   | Topic | Sends | Who |
   |---|---|---|
   | `session:<id>` | the window (1, 2) | the task page, `wisp attach`, the TUI |
   | `session:<id>/turn/<turn id>` | that one turn row whole and its events; empty if the turn is another task's or gone | *Show this turn* on a stub (`frame/turn-window.ts`, `turnOpener`) |
   | `session:<id>/turns` | every turn row whole, no events | the Changes pane and Compare (`keepTurnsWhole`) |
   | `session:<id>/all` | every turn whole and every event, from the tables (never the change feed) | the TUI, which draws every turn's steps |

   A malformed name (`session:/turn/t`, `session:s/turn/`) is never a turn topic. Subagents stay on their own topics
   (`session:<child>`), so a lead's window carries none of their runs.
4. **`TopicReader`, an additive hook in `wisp_api::v2_store`** (`StoreSnapshots::with_readers`): a plugin's
   `matches(topic)` + `read(reader, topic) → (kind, id, value)` answers a matching topic's full snapshot in place of the
   change feed and the `TopicSource`s (the first that matches). A resume (`since`) still reads the change feed. wisp
   serve registers wisp.runtime's when the `runtime` feature is on. The rows still leave through `kernel.egress`
   (ADR-0050).
5. **A change to a stub goes as the stub.** `TopicReader.live: Option<Live>` (additive) names `kinds` (runtime's:
   `turn`), a `change` hook and a `delta` hook:
   - `wisp_api::v2_store::feed_read` (wisp serve's feed; `feed_viewed` is it with no readers) passes each committed
     upsert or patch of one of `kinds` on a matching topic through `change`, on the store's writer thread right
     after the commit. `Some(rows)` sends upserts of those `(topic, id, value)` in the change's place, with its seq.
   - wisp.runtime's `live`: on a window, a turn that is not among the latest 8 goes as an upsert of **its stub**
     (`stub_row` of the row as committed) on `session:<id>`, then **whole** on `session:<id>/all`,
     `session:<id>/turn/<turn id>` and `session:<id>/turns`. The outbox takes a rank's topics by name, so the window's
     stub goes first in a flush: a client that opened the turn, or holds every turn, ends the frame with it whole; one
     that holds only the window ends it with the stub a fresh window would send. Nobody gets a diff its copy can't take.
   - Every other change goes as committed: the running turn (always among the latest 8: two indexed reads of two
     columns, `idx` of the 8th latest and the turn's own `idx`), a short task, a del, events, every other kind.
   - `delta`: a window's resume sends its changed older turns as stubs, so a resumed client never holds an older turn
     whole without its events.

## Edge cases (each has a test)

- The topic grammar, malformed turn topics — `a_task_topic_names_its_window_one_turn_or_every_turn` (core).
- 8 turns or fewer go whole; 257 send 249 stubs — `the_latest_eight_turns_go_whole_a_short_task_goes_whole` (core),
  `a_short_task_goes_whole`.
- A long task with many subagents: bytes before and after (20.1 MB → 0.75 MB), only the whole turns' events —
  `a_long_task_with_many_subagents_opens_as_a_window_bytes_before_and_after`.
- A lead's window carries no subagent row — `a_leads_window_carries_none_of_its_subagents_runs`.
- What a stub keeps and drops (stats, checkpoint, ratings, hero; not the answer, text or edits) —
  `a_stub_keeps_what_the_usage_card_sums_and_fork_reads_not_the_edits` (core),
  `a_stubbed_turn_keeps_its_stats_and_checkpoint_and_drops_its_answer_and_edits`.
- A Compact now stub keeps what it did — `a_compact_now_stub_keeps_what_it_did` (core and host).
- A turn row with no body — `a_turn_row_without_a_body_stubs_to_an_empty_one`.
- One older turn opened: only it and its events; another task's or a gone turn reads empty —
  `opening_an_older_turn_fetches_only_that_turn_and_its_events`, `a_turn_topic_never_reads_another_tasks_turn`.
- The Changes pane gets every turn whole without events — `the_changes_pane_gets_every_turn_whole_without_events`.
- The TUI's `/all` reads every turn and event from the tables, and a window resync keeps its whole turns —
  `the_tuis_all_view_reads_every_turn_whole_with_every_event_from_the_tables`,
  `a_window_resync_keeps_the_older_turns_whole_with_their_steps_v1_788` (TUI).
- The reader answers the first look; a resume still reads the feed —
  `a_topic_reader_answers_the_first_look_and_a_resume_reads_the_feed` (wisp-api).
- **The gap:** a change to a stubbed turn (a rating, a new answer, one more edit) as the store committed it fails on
  the stub (and without the failing op leaves a hybrid); it now goes as the stub a fresh window sends, then whole on
  the three other topics, in flush order —
  `a_change_to_a_stubbed_turn_goes_as_its_stub_so_a_client_holding_stubs_never_drifts`.
- The running turn, the oldest whole turn, a short task, another task's turn, a non-window topic and a non-turn kind
  go as committed; the turn just before the oldest whole one goes as its stub —
  `a_change_to_a_whole_turn_goes_as_committed`.
- A resume sends changed older turns as stubs, a whole one whole, and only on the window —
  `a_resumed_window_sends_the_older_turns_it_stubs_as_stubs`.
- The hook itself: its rows replace the change in their order with its seq; another kind or a del goes as committed;
  a resume goes through `delta` — `a_live_reader_sends_a_change_as_its_rows_and_a_resume_through_its_delta` (wisp-api).
- The page: a stub is recognised; opening one watches only that turn, once, and again after a resync re-stubs it; a
  turn that never comes (a peer without the window) gives the control back after 15 s; the Changes pane asks again
  when a resync re-stubs — `packages/shell/test/turn-window.test.ts` (4 tests, `_v1_788`).

## Consequences

- A long task's first look is about a 27th of what it was, and an older turn costs one small topic when unfolded.
- A committed `turn` change on a task topic costs the writer thread two indexed reads (an older turn: one more, its
  row) before it is sent. Events, the hot path while a task streams, pay nothing.
- A change to an older turn goes as an upsert of its stub instead of a diff, and as the whole row
  to clients on `/all`, `/turn/<id>` or `/turns`, which have the whole row anyway.
- Left as they are, each self-healing: a turn deleted (a rewind) makes an older stub "whole" by the count, so a later
  diff to it can fail on a client that still holds it as a stub and resync the window once; a flush cut by the
  outbox's byte budget between the window and the other topics shows the stub for one frame, and `turnOpener` asks for
  the turn again; a resume that re-stubs an opened turn makes `turnOpener` (or `keepTurnsWhole`) ask again.
- A kind another plugin puts on `session:<id>` is not in the window until `turn_window::read` names it.
