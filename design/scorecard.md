# UI/UX scorecard

A grid to measure whether a change makes wisp's page better, and to compare it with the tools people
use next to it (Cursor's agent panel, Codex, Claude Code). Each row is something you can check in
Chrome or count on a screenshot, not a matter of taste. Score 1–5 per row; 5 meets the target.

Use it with [checklist.md](checklist.md): the checklist says what to look at, this says how good it is.

## The grid

| # | Area | Criterion | How to measure | Target (5) |
|---|---|---|---|---|
| 1 | Clarity | Primary text is whole | Truncated task titles in the list at 1440px with a 360px sidebar | 0 cut while there is free room in the row |
| 2 | Clarity | Nothing said twice | Same value (state, time, cost, file count) shown twice in one view | 0 repeats in view |
| 3 | Clarity | Labels never cut to fragments | Labels shown as ≤ 3 letters + "…" ("Au…", "wi…") at 1440 / 1000 / 390px | 0 |
| 4 | Glanceability | State of every task readable from the list | Rows whose state (working / asking / finished / failed) needs a click | 0 |
| 5 | Glanceability | One place says what needs you | Needs you lists questions, approvals, finished work, crew reports | Always, above everything else |
| 6 | Feedback | Actions feel instant | Time from click to visible change (Mark done, Send, rename) | < 100 ms, rolled back with a toast on refusal |
| 7 | Stability | Nothing jumps | Pixels a row's time / pills move on hover, open, or refresh | 0 px |
| 8 | Stability | Loading never looks empty | Frames where a panel is blank before its data | 0: cached data or real-shaped placeholders |
| 9 | Density | Calm, not cramped | Distinct font sizes on one screen; colours used outside state | ≤ 5 sizes; colour only for state |
| 10 | Consistency | One kit | Hard-coded colours, one-off controls in the diff | 0 |
| 11 | Consistency | Same action, same name | Actions whose name differs between menu, details, palette, keys | 0 |
| 12 | Keyboard | Every core flow without a mouse | New task, move, open, reply, done, back | All, with visible hints on desktop only |
| 13 | Accessibility | Readable and reachable | Text contrast (AA 4.5:1 body, 3:1 hints); focus ring on every control; touch targets in the app | All pass; 44px in the app |
| 14 | Phones | 390px is first-class | Horizontal overflow; controls off the edge; keyboard hints on touch | 0 |
| 15 | Theming | Light and dark | Elements that read wrong in either theme | 0 |
| 16 | Multi-agent | Many tasks at once | Tasks visible and comparable at once; compare runs side by side | Yes, without leaving the page |

## Scores, October 2026

wisp is scored from screenshots of the page at 1440, 1000 and 390px (and 390px touch), light and dark,
with a QA wisp (fake agents). The other three are scored from their current public UI: a judgment,
not a measurement. *Review* is Gucci's (the crew's UI reviewer) independent pass after round 1;
*after* is after round 2, which fixed what that review found.

| # | Criterion | wisp before | wisp review (round 1) | wisp after | Cursor | Codex | Claude Code |
|---|---|---|---|---|---|---|---|
| 1 | Primary text is whole | 2 | 4 | 5 | 4 | 4 | 3 |
| 2 | Nothing said twice | 2 | 3 | 4 | 4 | 4 | 4 |
| 3 | No fragment labels | 2 | 5 | 5 | 4 | 4 | 5 |
| 4 | State readable from the list | 5 | 5 | 5 | 3 | 4 | 3 |
| 5 | One place for what needs you | 5 | 5 | 5 | 2 | 3 | 2 |
| 6 | Instant actions | 5 | 5 | 5 | 4 | 4 | 4 |
| 7 | Nothing jumps | 4 | 5 | 5 | 3 | 4 | 4 |
| 8 | Never empty while loading | 5 | 5 | 5 | 4 | 3 | 4 |
| 9 | Calm density | 3 | 3 | 4 | 3 | 4 | 4 |
| 10 | One kit | 5 | 5 | 5 | 4 | 5 | 5 |
| 11 | Same action, same name | 5 | 5 | 5 | 3 | 4 | 4 |
| 12 | Keyboard | 5 | 5 | 5 | 5 | 4 | 5 |
| 13 | Accessibility | 4 | 4 | 4 | 4 | 4 | 3 |
| 14 | Phones | 3 | 4 | 4 | 3 | 4 | 3 |
| 15 | Light and dark | 5 | 5 | 5 | 5 | 4 | 4 |
| 16 | Many tasks at once | 5 | 5 | 5 | 4 | 5 | 3 |
| | **Total (of 80)** | **65** | **73** | **76** | **59** | **64** | **60** |

## What changed

Round 1:

- **Row titles use the row (1).** The sidebar's state and PR pills used to take a column that ran
  the height of the row, so a title stopped halfway ("Fake claude …") beside empty space. The pills
  now sit on the second line only and the time is pinned in the corner: titles run to the time.
- **No "Au…" in the launcher (3).** The place's label folds to its icon under 800px of box (was
  720px), so the harness keeps its name and the model shows beside it.
- **The result doesn't repeat its numbers (2).** A finished turn's hero said "1s · $0.01 · 1 file
  touched", and the trail right under it said 1s, $0.01 and 1 file again. In a task the hero keeps
  only its state; the trail has the numbers (Compare and crew threads keep them).
- **The branch on a phone (3, 14).** In a stacked task the branch shrank to "wi…" at the end of the
  first row; with too little room it now gets a line of its own.

Round 2 (from the review):

- **Titles never run under the time.** Scheduled rows (whose time is "Thu 09:00") reserve 88px, and
  on touch screens, where the done button has its own column, titles reserve both.
- **The account label keeps its old fold (720px)**; only the place folds sooner.
- **The result's heading isn't the task's title again (2).** When the hero's title is the task's
  title, which the head above already shows, the hero drops it and leads with its summary.
- **Ship it and Mark done once (2, 9).** In split view the task's bar is sticky (or is the details
  column), so the reply box no longer repeats its two coloured buttons.

## Still below 5

- **2:** *Finished* shows in the details column and in the result's pill. The pill is the agent's
  own verdict (Finished / Partly done / Blocked), so it stays. Two overlap notices for two tasks
  with the same title read alike (that's the fake agent's titles).
- **9:** 7 font sizes on a task screen; Full auto stays amber because it's a state (no approvals).
- **13:** `--faint` hints are 3:1 by design; body text passes AA.
- **14:** a stacked task's head can take three rows (facts, branch, actions) before the result.
