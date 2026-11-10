# v1 → v2 sync log

The owner keeps fixing wisp v1 (`origin/main`) while v2 is built. At every coder hand-off the lead lists the v1
commits since the last sync (`git log <last>..origin/main`), decides for each what v2 needs, and queues it here and in
`docs/v2-queue.md`. v2 ports the intent (and the test's scenario), not the JS.

Last synced v1 commit: **c855acd6** (2026-11-10)

| v1 | What it fixed | v2 action |
|---|---|---|
| #759 477215ab | overlaps test waits on the service, not 20 s | test-only in v1; v2's overlaps (if ported) uses the same "await settled" pattern |
| #760 cd4171f2 | a quiet crew check-in's scheduled follow-up no longer lapses (it was archived at turn end) | **queue:** v2 crew: a quiet job that still has `later` entries is filed Done, not archived; named test `a_quiet_check_in_keeps_its_scheduled_follow_up` |
| #761 cdc12dbc | desktop: target=_blank clicks open in the browser (opener plugin's JS-link script was refused by capabilities) | **queue:** v2's `apps/desktop` (Tauri): register the opener with `open_js_links_on_click(false)`; clicks go through `on_new_window` → `open_outside`; test like v1's TAURI-06 real click |
| #763 f0291d3f | Fable in the Claude picker; Auto routes to it (tier row counts, probation without a score); `fable` vendor; Compact prices $8/$0.20/$40 | **check:** v2 has the catalogue and router rank (round 8). Also port: probation when there's no benchmark score, the bare `fable` vendor id, and Compact pricing for claude-fable-5-2 |
| #764 c855acd6 | a crew member's job uses the harness/model/level picked in the launcher (`crewRun`, that job only); the picker shows the member's setup; channels still can't change it | **queue:** v2 crew + composer: the launcher shows the member's harness/model/effort, a change goes with the launch for that job only; named test `a_launcher_pick_overrides_the_member_for_that_job_only` |
