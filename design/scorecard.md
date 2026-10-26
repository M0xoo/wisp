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

## How to measure

Rows 9, 13 and 14 have numbers you can take from the page, so take them rather than eyeball them.
Start a QA wisp with fake agents (`qa/lib.mjs` `startWisp`), open home and a finished task, and in
each of the 20 views (1440, 1000, 390px browser, 390px touch, 390px phone app with `wispMobile` in
the user agent; light and dark):

- **Font sizes:** count the distinct computed `font-size` of visible text nodes (target ≤ 5).
- **Overflow:** `scrollWidth - clientWidth` of the page (target 0).
- **axe-core** (installed in `/tmp`, not the repo) with `wcag2a` and `wcag2aa` (target 0 violations;
  this covers contrast, names and nested controls).
- **Focus:** press Tab through home and a task; every stop must draw a ring (outline or box-shadow).
- **Taps:** in the app view, visible controls under 44px on either side (target 0).

## Scores, October 2026

The other three are scored from their current public UI: a judgment, not a measurement. Each wisp
column after *before* is Gucci's (the crew's UI reviewer) independent score, given from the
screenshots, the measurements above and the diff.

| # | Criterion | wisp before | round 1 | round 2 | round 3 | round 4 | Cursor | Codex | Claude Code |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Primary text is whole | 2 | 4 | 5 | 4.5 | 5 | 4 | 4 | 3 |
| 2 | Nothing said twice | 2 | 3 | 3 | 4.5 | 5 | 4 | 4 | 4 |
| 3 | No fragment labels | 2 | 5 | 4 | 5 | 5 | 4 | 4 | 5 |
| 4 | State readable from the list | 5 | 5 | 5 | 5 | 5 | 3 | 4 | 3 |
| 5 | One place for what needs you | 5 | 5 | 5 | 5 | 5 | 2 | 3 | 2 |
| 6 | Instant actions | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 4 |
| 7 | Nothing jumps | 4 | 5 | 5 | 5 | 4.75 → 5¹ | 3 | 4 | 4 |
| 8 | Never empty while loading | 5 | 5 | 5 | 5 | 5 | 4 | 3 | 4 |
| 9 | Calm density | 3 | 3 | 4 | 5 | 5 | 3 | 4 | 4 |
| 10 | One kit | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 5 |
| 11 | Same action, same name | 5 | 5 | 5 | 5 | 5 | 3 | 4 | 4 |
| 12 | Keyboard | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 5 |
| 13 | Accessibility | 4 | 4 | 4.5 | 5 | 5 | 4 | 4 | 3 |
| 14 | Phones | 3 | 4 | 4 | 4.5 | 5 | 3 | 4 | 3 |
| 15 | Light and dark | 5 | 5 | 5 | 5 | 5 | 5 | 4 | 4 |
| 16 | Many tasks at once | 5 | 5 | 5 | 5 | 5 | 4 | 5 | 3 |
| | **Total (of 80)** | **65** | **73** | **73.5** | **77.5** | **80** | **59** | **64** | **60** |

¹ Round 4 gave 4.75: the details column's clock time came and went with the task's state, moving
the actions under it. Its fix (the time shows only before a task's first prompt) is in; that makes
the row a 5 by the review's own words.

Measured after round 4, in all 20 views: 3–5 font sizes (was 7–10), 0 overflow, 0 axe-core
violations (was 7: contrast, nested controls, a prohibited label), 40 Tab stops all ringed, 0 app
controls under 44px (was 7).

## What changed

Round 1 (merged in #350):

- **Row titles use the row.** The pills sit on the second line; titles run up to the time.
- **No "Au…" in the launcher.** The place folds to its icon under 800px of box.
- **The result doesn't repeat its numbers or its title** (the trail and the head have them).
- **Ship it and Mark done once** in split view (the bar keeps them in reach).

Round 2 (this branch):

- **One type scale** (rows 9, 10): every size in `web/css` mapped onto 11.5 / 12.5 / 13 / 14 and one
  display size; the task's head title is 14px. `design/ui.md` → Type.
- **Hints at AA** (row 13): `--faint` 4.5:1 on `--bg-2` in both themes, `--muted` a step darker.
- **No nested controls** (row 13): the row's hover done is a pointer shortcut (keys have E, the bar
  has Mark done); Crew's + sits beside its fold heading, not in it; logos with a tip are `role=img`
  and draw a focus ring.
- **Said once** (row 2): the latest result drops its own state pill in a task; the bar drops its
  overlap count while the overlap notices show; with the list beside the task the bar drops the
  state (the open row says it) and the clock time (the prompt's foot says it); home's Needs you
  drops the state word beside the sidebar.
- **Colour for state only** (row 9): Plan, Full auto and Worktree read in ink with only the
  icon tinted (Worktree's on is ink, not blue); Recipes and Auto's mark are neutral.
- **Phones** (rows 3, 14): the task's bar is facts, then actions with the branch beside them (cut in
  the middle, "wisp/add-a-rat…-9c5e26"); on touch the branch takes its own line. Overlap reasons wrap
  under their title. The app's section folds, Crew's +, project chips, Open and the trail buttons
  are 44px.
- **Tokens** (row 10): the terminal's greys, line and states are `--term-*` tokens.

## Still to watch

- Home's Needs you repeats the sidebar's titles side by side. It's the inbox by design (it must
  list what needs you above the tips); its rows say nothing else twice.
