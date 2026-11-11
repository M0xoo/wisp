# v1 → v2 sync log

The owner keeps fixing wisp v1 (`origin/main`) while v2 is built. At every coder hand-off the lead lists the v1
commits since the last sync (`git log <last>..origin/main`), decides for each what v2 needs, and queues it here and in
`docs/v2-queue.md`. v2 ports the intent (and the test's scenario), not the JS.

Last synced v1 commit: **d5056a54** (2026-11-11)

| v1 | What it fixed | v2 action |
|---|---|---|
| #759 477215ab | overlaps test waits on the service, not 20 s | test-only in v1; v2's overlaps (if ported) uses the same "await settled" pattern |
| #760 cd4171f2 | a quiet crew check-in's scheduled follow-up no longer lapses (it was archived at turn end) | **queue:** v2 crew: a quiet job that still has `later` entries is filed Done, not archived; named test `a_quiet_check_in_keeps_its_scheduled_follow_up` |
| #761 cdc12dbc | desktop: target=_blank clicks open in the browser (opener plugin's JS-link script was refused by capabilities) | **queue:** v2's `apps/desktop` (Tauri): register the opener with `open_js_links_on_click(false)`; clicks go through `on_new_window` → `open_outside`; test like v1's TAURI-06 real click |
| #763 f0291d3f | Fable in the Claude picker; Auto routes to it (tier row counts, probation without a score); `fable` vendor; Compact prices $8/$0.20/$40 | **check:** v2 has the catalogue and router rank (round 8). Also port: probation when there's no benchmark score, the bare `fable` vendor id, and Compact pricing for claude-fable-5-2 |
| #764 c855acd6 | a crew member's job uses the harness/model/level picked in the launcher (`crewRun`, that job only); the picker shows the member's setup; channels still can't change it | **queue:** v2 crew + composer: the launcher shows the member's harness/model/effort, a change goes with the launch for that job only; named test `a_launcher_pick_overrides_the_member_for_that_job_only` |
| #766 dd0764eb | the issue picker lists Linear and Jira issues from a signed-in (OAuth) connector through its own MCP tools (Linear `list_issues`, Atlassian `searchJiraIssuesUsingJql`), falling back to the workspace's open Linear issues; "Connect Linear… / Jira…" opens the connector form prefilled | **queue (backend-coder, with the issues.projects work):** issues lists through a signed-in connector's tools; **UI coder:** the Connect… links open the prefilled connector form; test like v1 `issue-signin.test.js` |
| #768 a782a639 | a picked crew member tints the task panel (TRY-18) | **queue (UI coder):** the crew rail pick tints the task panel as v1, parity-checked |
| #767 1f66e31c | release 0.58.0 | v1 only (v2 keeps its Unreleased) |
| #769 ca2dff27 | with Goal on and "Done when" empty, Send asks first instead of sending a goal-less task | **queue (UI coder):** the composer asks the same; named test |
| #771 3435a2b9 | the launcher drops "Try it two ways"; + already adds a run, and "What's different" opens from a run added with + | **queue (UI):** match: no Try-two button; the compare group opens from a + run |
| #772 2c021cb4 | drag projects into your own order everywhere they show (top bar chips, New task's in row, +N list, Projects dialog); one stored order | **done (round 17):** one order (`runtime.projectOrder`), drag (and Alt+arrows) in the top bar, New task's row, shell-list's chips and the Projects dialog; projects reach the app (published on `config`) |
| #773 f52dfcf0 | phone Back from a subagent's run goes to its lead | **queue (phone frontend, item 8):** navigation Back from a subagent opens its lead |
| #774 d5056a54 | the phone gets only the subagent turns its window shows (a lead with 48 subagents sent them all) | **check:** v2's sync sends topics by window/cursor; make sure a lead's task view doesn't subscribe every subagent's full turns; test with many subagents |
