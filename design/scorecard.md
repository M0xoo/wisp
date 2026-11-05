# UI/UX scorecard

A grid to measure whether a change makes wisp's page better, and to compare it with the tools people
use next to it (Claude Code, Codex, Cursor, and the agent managers Conductor, Superset, Emdash and Vibe
Kanban). The latest standing is *Where wisp stands, November 2026*; round 5's grid follows it. Each row is something you can check in
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

Rows 3, 9, 13 and 14 have numbers you can take from the page, so take them rather than eyeball
them: `node qa/ui-audit.mjs` takes all of them on every view `qa/views.mjs` opens (36: New task and
its menus and pickers, a task with its goal, panels, dialogs and menus, crew and Org, My Stuff, the
palette and every Settings pane) at five sizes (1440, 1000, 390px browser, 390px touch, 390px phone
app with `wispMobile` in the user agent), light and dark: 426 views, each in a fresh browser, with a
dialog measured on its own when one is open. `QUICK=1 node qa/buttons.mjs` measures every button in
the same views. What it checks:

- **Font sizes:** count the distinct computed `font-size` of visible text nodes (target ≤ 5).
- **Overflow:** `scrollWidth - clientWidth` of the page (target 0).
- **axe-core** (installed in `/tmp`, not the repo) with `wcag2a` and `wcag2aa` (target 0 violations;
  this covers contrast, names and nested controls).
- **Focus:** press Tab through home and a task; every stop must draw a ring (outline or box-shadow).
- **Taps:** in the app view, visible controls under 44px on either side (target 0). WCAG 2.5.8's
  own exceptions stand: a link inside a sentence, a box whose label takes the tap.
- **Cut labels:** a label of 24 characters or fewer cut with `…` (target 0). Long previews may be
  cut; the branch's middle cut (head and tail both showing) is meant.

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

## Round 9: the features built, and what's left

Gucci's round 9: **jobs 68.5/70** (Cursor 3 56, Codex 49), **craft 75/80** (the new screens cost
three points; its eight defects are fixed on this branch since), total **143.5/150** against Cursor
3's 115. Wisp is the best or tied-best in 13 of the 14 jobs; it trails only in **Edit code, 4.5 vs
Cursor's 5**.

Built for round 9, each on a screen wisp already had:

| Feature | Who had it | Where in wisp |
|---|---|---|
| Stage, unstage and commit, by file or hunk | Codex | Changes: *Stage / Part / Staged*, hunk *Stage*, a commit row, ⌘K |
| Run the app per worktree, preview it, pick an element | Conductor, Superset, Vibe Kanban, Cursor | The side panel's **Preview** tab (`.wisp/worktree.json` `run`/`port`, Conductor's run script), Pick |
| Start from an issue list | Conductor, Emdash, Vibe Kanban | New task's **Issue**: GitHub, Linear, Jira |
| Triggers from outside | Cursor Automations | Webhook, Slack, Linear, Sentry, PagerDuty (Settings → Webhook triggers) |
| Language intelligence | Cursor | The editor's language server: definition, references, hover, rename, completions, problems |
| Plan usage before you start | Codex, Cursor | Beside each harness in the picker |

Still missing, and why they aren't on this branch:

| Feature | Who has it | What it takes |
|---|---|---|
| An iPhone app | Claude Code, Codex, Cursor | A new app: Swift, an SSH tunnel to replace sshj (Java), App Store review |
| Voice dictation inside the app | Codex, Cursor, Claude | Native speech-to-text: an Android plugin and Electron's main process (the Web Speech API works in neither). System dictation types into wisp today |
| AI completions as you type (ghost text), multi-cursor, squiggles under the text | Cursor | A code editor engine (CodeMirror or Monaco) in place of the textarea, and a completion model: wisp becoming an IDE |

## Round 8: every category, and the features the others have

Gucci's round 8: **craft 78/80**, **jobs 67.5/70**, overall **145.5/150** (Cursor 3 114, Codex 113,
Conductor 103.5, Claude Code 103, Superset 99, Emdash 96, Vibe Kanban 95). Competitors were
re-checked against their late-2026 docs (Cursor Automations, Claude Code Remote Control, the Codex
app's review pane), not used hands-on.

| Job | wisp | best other | |
|---|---|---|---|
| Start a task | 5 | Cursor 3 5 | tied |
| Run in parallel, isolated | 5 | Conductor, Superset 5 | tied |
| Watch progress | 5 | 4 | **ahead** |
| Answer, approve | 5 | Claude Code 4.5 | **ahead** |
| Review changes | 5 | Cursor 3 5 | tied |
| Edit code | 4 | Cursor 3 5 | **behind** |
| Ship (PR, merge) | 5 | Conductor 4.5 | **ahead** |
| Recover, rerun | 5 | 4 | **ahead** |
| Many harnesses, models | 5 | Emdash 5 | tied |
| Schedule, background | 5 | Cursor 3 4.5 | **ahead** |
| Phone, remote | 4.5 | Codex, Claude Code 4 | **ahead** |
| Find past work | 5 | 4 | **ahead** |
| Crew, delegation | 5 | 1.5 | **ahead** |
| Cost and limits | 4 | Cursor 3, Codex 4 | tied |

Round 8's eight defects were all look-and-feel and are fixed on this branch: hunk Revert in its own
head row (never over code), the kit's own lists instead of 12 native `<select>`s (desktop), Viewed
says its word on phones, goal rounds named and quieter, the overlap notice one line, the bar one row
at 1000px with the panel open, Save shown only when there's something to save, copy.

### Must-have features: wisp against the field

| Feature | Who has it | wisp | Kind of work |
|---|---|---|---|
| Edit a file beside the agent | Cursor, Conductor, Superset | **Built** (round 6): editor in Changes, Open file…, Save that won't overwrite | — |
| Search the task's files; go to definition | Cursor | **Built** (round 8): ⌘P text search, ⌘-click / F12 | — |
| Comment on a diff line, send it back | Cursor, Codex, Conductor | **Built** (round 6) | — |
| Revert a hunk or a file; Viewed per file | Cursor, Codex, GitHub | **Built** (round 8), with Undo | — |
| @ a file in the prompt | Cursor, Claude Code, Codex | **Built** (round 8) | — |
| Worktrees with ignored files and a setup step | Cursor, Claude Code, Conductor | **Built** (round 8): `.worktreeinclude`, `.wisp/worktree.json`, Cursor's file, Conductor's files | — |
| Search past work by its words | Cursor, Vibe Kanban | **Built** (round 6) | — |
| Plan usage before you start | Codex, Cursor | **Built** (round 8): beside each harness in the picker | — |
| Stage, unstage and commit from the diff | Codex | Missing: wisp commits through Ship it | A feature on Changes |
| Run the dev server per worktree, preview it, pick an element | Conductor, Superset, Vibe Kanban, Cursor | Missing: only the page an agent puts up (Watch) | A feature: a Run step and a Preview tab |
| Start from a list of issues (Linear, GitHub, Jira) | Conductor, Emdash, Vibe Kanban | Missing: labelled GitHub issues as a trigger only | A feature on New task |
| Triggers from Slack, Linear, Sentry, webhooks | Cursor Automations | Missing: schedule, CI, GitHub issues, finished | A feature per integration |
| Voice dictation in the app | Codex, Cursor, Claude | Missing: system dictation types into wisp's boxes | Native work in Electron and Android (the Web Speech API works in neither) |
| An iPhone app | Claude Code, Codex | Missing: the browser at your grid address | **A new product** (the tunnel is sshj, Java) |
| Language intelligence (types, references, rename) | Cursor | Missing: *Open files in* your editor | **A new product: an IDE** |

## Where wisp stands, November 2026 (rounds 6 and 7)

Round 5 measured 2 views per size. The judges asked for every page, every state of it, every modal,
picker and nested input, in every size: so round 6 built `qa/ui-audit.mjs` and ran it on 36 views ×
5 sizes × 2 themes. That found what the 2-view audit never opened.

### Measured: every view, every size

| Measure | First full run (219 of the 426 views opened¹) | After round 6 (all 426) | Target |
|---|---|---|---|
| axe-core `wcag2a` + `wcag2aa` violations | 161 hits of 7 rules: a `tablist` holding a heading (Settings), listboxes holding notes (harness picker), a `menu` holding a heading (Run on), a button in a button (transcript steps), 35 unnamed controls (Settings switches and lists, dialogs' ×, fields), a link told apart by colour only, faded removed lines under AA | **0** | 0 |
| Most font sizes on one screen | 9, and over 5 in 67 views (Settings: 16, 17, 18 and 22px headings; 10.5px badges; the browser's own 10.4px `<small>`) | **5** | ≤ 5 |
| Short labels cut with `…` | 112 (row previews squeezed by *Overlap ×4*, Auto's pick, an Org card's role) | **0** | 0 |
| App controls under 44px | 292 (Needs you rows, transcript steps, folds, switches, segments, fields, dialog buttons, chips, the mini bar, toasts) | **0** | 0 |
| Page overflow | 0 | 0 | 0 |
| `qa/buttons.mjs` (11,783 buttons, 299 views) | 5 spacing issues once its views covered dialogs and panels | **0** | 0 |

¹ The first run reused one page for every view, so a task or panel left open hid the next view's
buttons; from the second run each view starts in a fresh browser and all 426 open. The first
run's numbers are a floor.

### The craft grid, rounds 6 and 7 (Gucci's)

Gucci scored round 6 at **75** and round 7 at **77** of 80, from screenshots, the audit and the
code. Round 7's rows under 5, and what this branch did about them after it:

| Row | Round 7 | Why | After |
|---|---|---|---|
| Hierarchy | 4.5 | A phone task has ~430px of chrome before its first turn | The bar went from three rows to one; the Shell card and the branch line stay (each says something the bar doesn't) |
| Copy | 4 | *Where files open* in the app, where that row is hidden; the finder's wording | Fixed (the app's General says how tasks start; *Find a file in this task's folder…*). *Babysitting mode (Terminals)* is the setting's own name and stays |
| Consistency | 4 | One action under two names: *Take over* / *Take over in a terminal*, *Transcript* / *Show the full transcript*, *Changes* / *Show changes*, *Shell* / *Open shell*; the gutter mark was a stripe | Fixed: one name everywhere (bar, More, right-click, ⌘K, keys), the panel's tab names; the mark is the number in green |
| Phone | 4.5 | The app's More repeated Changes and Shell from the bar; the last card may open under the Overlaps strip | More drops what's on the page; the strip is unproven (the 390px browser shows the card) |

The other 12 rows are 5. The competitors' craft scores are judged from their public UI, not measured;
they stand as in round 5 (Codex 64, Claude Code 60, Cursor 3 59, Conductor 59, Superset 56, Emdash
55, Vibe Kanban 52, of 80).

### The jobs, round 7 (Gucci's)

Gucci's grid from round 6 on: 14 jobs, 1–5. Competitors from public UI and docs, late 2026.

| Job | wisp | Cursor 3 | Codex | Conductor | Superset | Vibe Kanban | Claude Code | Emdash |
|---|---|---|---|---|---|---|---|---|
| Start a task | **5** | 5 | 4.5 | 4 | 4 | 4 | 4.5 | 4 |
| Run in parallel, isolated | **5** | 4 | 4.5 | 5 | 5 | 4.5 | 3.5 | 4.5 |
| Watch progress | **5** | 4 | 4 | 4 | 4 | 3.5 | 4 | 3.5 |
| Answer questions, approve | **5** | 4 | 4 | 3.5 | 3 | 3 | 4.5 | 3 |
| Review changes | 4.5 | **5** | 4 | 4.5 | 4 | 4 | 3.5 | 3.5 |
| Edit code | 3.5 | **5** | 3 | 3.5 | 3.5 | 2.5 | 2.5 | 2.5 |
| Ship (PR, merge) | **5** | 4 | 4 | 4.5 | 4 | 4 | 3 | 4 |
| Recover, rerun | **5** | 4 | 3.5 | 3 | 3 | 3 | 3.5 | 3 |
| Many harnesses and models | **5** | 3 | 1 | 3 | 4 | 4.5 | 1 | 5 |
| Schedule, background | **5** | 3 | 4 | 1 | 1 | 1 | 2.5 | 1 |
| Phone, remote | 4 | 3 | 4 | 1 | 1 | 2 | 3 | 1 |
| Find past work | **4.5** | 4 | 3 | 3 | 3 | 4 | 3 | 3 |
| Crew, delegation | **5** | 1 | 1 | 1.5 | 1.5 | 1.5 | 1.5 | 1 |
| Cost and limits | 4 | 4 | 4 | 3 | 2 | 1.5 | 2.5 | 2 |
| **Total (of 70)** | **65.5** | 53 | 48.5 | 44.5 | 43 | 43 | 42 | 41 |

Round 6 to 7 for wisp: Review 3.5 → 4.5 (comments on diff lines, by pointer, touch and keyboard,
sent with the next follow-up), Edit 2 → 3.5 (an editor in Changes, Open file…, the task's lines
marked), Find past work 3 → 4.5 (⌘K searches prompts and answers), Start a task 5 (first run).

### Overall (of 150)

| | wisp | Codex | Cursor 3 | Conductor | Claude Code | Superset | Vibe Kanban | Emdash |
|---|---|---|---|---|---|---|---|---|
| Craft (of 80) | 77 | 64 | 59 | 59 | 60 | 56 | 52 | 55 |
| Jobs (of 70) | 65.5 | 48.5 | 53 | 44.5 | 42 | 43 | 43 | 41 |
| **Total** | **142.5** | 112.5 | 112 | 103.5 | 102 | 99 | 95 | 96 |

wisp leads the total by 30 points and every craft row but four. Job by job it is alone at the top in
7, level with the best in 5 (start, parallel, harnesses, phone, cost), and behind in 2:

| Job | Gap | What it would take | Kind |
|---|---|---|---|
| Edit code (3.5 vs Cursor's 5) | Search across files, go to definition, refactors | A text search in the finder is polish; the rest is an editor engine | **A new product: an IDE.** Cursor is one; wisp opens files in yours (*Open files in*) |
| Review changes (4.5 vs Cursor's 5) | Accept or revert one hunk; a *Viewed* tick per file | `git apply -R` on one hunk from Changes, a viewed count | A feature on Changes |
| Phone, remote (4, level with Codex) | ~430px of chrome before the first turn | The branch into the pill row, Shell on the bar | Polish |
| Cost and limits (4, level) | No usage meter before you start | The plan's windows beside the harness in New task | A feature on New task |

## Round 5 and the market, November 2026

Round 4's 80 didn't hold: features merged since then brought back 12px and 13.5px text, a button
inside the row's button, a contrast miss and cut labels. Round 5 re-measured all 20 views first,
fixed what it found, and widened the comparison from three tools to the seven desktop apps people
actually pick between for running agents, on two grids: the craft rows above, and the jobs an agent
manager is for.

### Measured, before → after round 5

All 20 views (1440, 1000, 390px browser, 390px touch, 390px phone app; light and dark; home and an
open task with a goal), with the scripts under *How to measure*:

| Measure | Before | After | Target |
|---|---|---|---|
| axe-core `wcag2a` + `wcag2aa` violations | 2 rules in every view: `nested-interactive` (6 review rows), `color-contrast` (a time on wisp's tint) | 0 | 0 |
| Distinct font sizes on a screen | 5–7 (12px, 13.5px strays) | 4–5 | ≤ 5 |
| Labels cut with `…` per view | 12–13 (*Default mo…*, *This compu…*, *Make the tests p…*, *Fake claude fin…*, *Full…*) | 0–3 (long previews and a branch only) | only text longer than its room |
| Page overflow | 0 | 0 | 0 |
| App controls under 44px | 3 (Resume goal, Show all, + n more) | 0 (the reply box's textarea is 34px inside its 56px box) | 0 |
| `qa/buttons.mjs` (10,098 buttons in 271 views) | 0 issues | 0 issues | 0 |

### The craft grid, round 5

Gucci's independent score, from the screenshots, the measurements and the diff, is **74**: stricter
than round 4, and most of its deductions predate this round. *After its fixes* raises only the rows
whose stated reason is gone, and says which; the rest stay as Gucci gave them. The other tools are
judged from their public UI, not measured: Claude Code, Codex and Cursor keep October's scores,
Conductor, Superset, Emdash and Vibe Kanban are new this round.

| # | Criterion | wisp r4 | wisp r5 (Gucci) | after its fixes | Claude Code | Codex | Cursor 3 | Conductor | Superset | Emdash | Vibe Kanban |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Primary text is whole | 5 | 5 | 5 | 3 | 4 | 4 | 4 | 3 | 4 | 3 |
| 2 | Nothing said twice | 5 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 3 |
| 3 | No fragment labels | 5 | 4.5 | 4.5 | 5 | 4 | 4 | 4 | 4 | 4 | 3 |
| 4 | State readable from the list | 5 | 5 | 5 | 3 | 4 | 3 | 4 | 3 | 3 | 4 |
| 5 | One place for what needs you | 5 | 5 | 5 | 2 | 3 | 2 | 3 | 3 | 2 | 3 |
| 6 | Instant actions | 5 | 5 | 5 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| 7 | Nothing jumps | 5 | 4.5 | 4.5 | 4 | 4 | 3 | 4 | 4 | 4 | 3 |
| 8 | Never empty while loading | 5 | 5 | 5 | 4 | 3 | 4 | 4 | 3 | 3 | 3 |
| 9 | Calm density | 5 | 4.5 | 4.5 | 4 | 4 | 3 | 4 | 3 | 4 | 3 |
| 10 | One kit | 5 | 4 | 4 | 5 | 5 | 4 | 4 | 4 | 4 | 4 |
| 11 | Same action, same name | 5 | 4 | 4.5¹ | 4 | 4 | 3 | 4 | 4 | 4 | 3 |
| 12 | Keyboard | 5 | 5 | 5 | 5 | 4 | 5 | 4 | 4 | 3 | 3 |
| 13 | Accessibility | 5 | 4.5 | 5² | 3 | 4 | 4 | 3 | 3 | 3 | 3 |
| 14 | Phones | 5 | 4 | 4.5³ | 3 | 4 | 3 | 1 | 1 | 1 | 2 |
| 15 | Light and dark | 5 | 5 | 5 | 4 | 4 | 5 | 4 | 4 | 4 | 4 |
| 16 | Many tasks at once | 5 | 5 | 5 | 3 | 5 | 4 | 4 | 5 | 4 | 4 |
| | **Total (of 80)** | **80** | **74** | **75.5** | **60** | **64** | **59** | **59** | **56** | **55** | **52** |

¹ The task's bar said *Ship it*, *Push to #12* and *Ship again* where the menus and ⌘K say *Ship it…*
and *Push to PR #12*; it uses their words now. The bar's *Changes* and *Shell* stay nouns: they are
toggles that open and close the panel, where *Show changes* would be wrong once it's open.
² Gucci held back the half point because 8 of the 20 views and the tap check hadn't run; they have:
0 violations in all 20, 0 app controls under 44px.
³ The overlap notices take one row on a phone (they covered a quarter of the answer and clipped the
card above them); the check line wraps whole instead of ending in *not_…*. Seven icon-only buttons in
the phone's task bar remain (they have names and tips, but no words).

### The jobs an agent manager is for

Gucci's scores, 1–5, from each app's public UI and docs as of late 2026: a judgment, not a
measurement. Claude Code is Anthropic's desktop app (the redesigned one for parallel sessions), Codex
is the Codex app inside ChatGPT's desktop app, Cursor 3 its Agents Window.

| Job | What 5 looks like | wisp | Claude Code | Codex | Cursor 3 | Conductor | Superset | Emdash | Vibe Kanban |
|---|---|---|---|---|---|---|---|---|---|
| First run | A first task running in a minute, no setup questions | 4 | 4 | 4.5 | 4 | 4.5 | 3.5 | 3.5 | 3.5 |
| Launching a task | Harness, model, place and mode picked in the prompt box | 4.5 | 4 | 4.5 | 4.5 | 4 | 3.5 | 4 | 3.5 |
| Watching many agents | Every agent's state and progress readable from one list | 4.5 | 3 | 4 | 4 | 4 | 4 | 3.5 | 4 |
| What needs you | One inbox for questions, approvals and finished work | 5 | 2 | 3 | 3 | 3 | 3 | 2.5 | 3 |
| Reviewing work | Line-level diff review, comments back to the agent | 3.5 | 3.5 | 4 | 4.5 | 4 | 3.5 | 3.5 | 4 |
| Comparing runs | Same task on several agents, side by side, pick one | 4 | 2 | 4 | 4 | 3 | 3 | 3.5 | 3 |
| Shipping | PR, checks, merge and conflicts without leaving | 4 | 3.5 | 4 | 4 | 4.5 | 3.5 | 3.5 | 4 |
| Keeps going | Goals, schedules, queued follow-ups | 5 | 3 | 3.5 | 3 | 2.5 | 2 | 2 | 2.5 |
| Any harness, any machine | Every CLI, local and remote | 5 | 2 | 2 | 2.5 | 3 | 4.5 | 4.5 | 4.5 |
| Away from the desk | Phone app, notifications, answer from the lock screen | 4.5 | 4 | 4 | 3.5 | 1 | 1.5 | 1.5 | 2 |
| Long-lived agents and memory | Named agents that remember and run on a schedule | 4.5 | 2.5 | 2.5 | 2.5 | 1.5 | 1 | 1 | 1 |
| Make it yours | Change any part of the UI | 5 | 3 | 2.5 | 3.5 | 2.5 | 3 | 2.5 | 2.5 |
| Editing code yourself | A real editor beside the agent | 2 | 2 | 2.5 | 5 | 3 | 3.5 | 2.5 | 2.5 |
| Navigation | Palette, keys, Back, one way to every place | 5 | 3.5 | 3.5 | 5 | 4 | 3.5 | 3 | 3 |
| | **Total (of 70)** | **60.5** | **42** | **48.5** | **53** | **44.5** | **43** | **41** | **43** |

### Overall (of 150)

| | wisp | Codex | Cursor 3 | Conductor | Claude Code | Superset | Emdash | Vibe Kanban |
|---|---|---|---|---|---|---|---|---|
| Craft (of 80) | 75.5 | 64 | 59 | 59 | 60 | 56 | 55 | 52 |
| Jobs (of 70) | 60.5 | 48.5 | 53 | 44.5 | 42 | 43 | 41 | 43 |
| **Total** | **136** | **112.5** | **112** | **103.5** | **102** | **99** | **96** | **95** |

wisp leads both grids and the total by 23.5 points. Job by job it leads 7 of the 14, ties 3
(launching, comparing runs, navigation) and trails in 4, which are the work for next rounds:

- **Editing code yourself** (2 vs Cursor's 5): wisp has a shell and *Take over* but no editor. It
  opens files in yours (Settings → *Open files in*); an editor of its own is a product decision, not
  polish.
- **Reviewing work** (3.5 vs Cursor's 4.5, Codex's 4): Changes shows every diff, but you can't comment
  on a line and send it back to the agent.
- **First run** (4 vs Codex's and Conductor's 4.5): New task has eleven controls before you type.
- **Shipping** (4 vs Conductor's 4.5): Conductor's merge flow is one place; wisp's is spread over
  Ship it…, the PR strip and the side panel's PR tab.

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

Round 5 (this branch):

- **One type scale again** (row 9): 70 off-scale sizes (12px, 13.5px, 11px, 10.5px, 14.5px) in 13
  stylesheets mapped onto 11.5 / 12.5 / 13 / 14; mono in panels is 11.5, the diff 12.5.
- **No nested control** (row 13): the row's hover *Save for later* is a pointer shortcut like Mark
  done's (L and More have it). The time on a round wisp sent back is `--muted` on its tint.
- **Whole labels** (rows 1, 3): rows and a crew member's details name the model only when one was
  picked (*Default model* stays in the tip); a phone's turn list drops the result title so the prompt
  is whole, and today's turns say *23:49*, not *1 Nov, 23:49*; the goal's check line wraps on narrow
  screens and its tip is the whole line; the harness picker's Auto says *Picks per task*.
- **Same name** (row 11): the task's bar uses `shipLabel` (*Ship it…*, *Push to PR #12*) like the menus.
- **⌘K** (row 12): tasks first, then the crew; a member's chores (delegates, share, track record,
  import) show once you type.
- **Phones** (row 14): one overlap row on a stacked page; Resume goal, Show all and *+ n more* are
  44px in the app without moving the layout.

Rounds 6 and 7 (this branch, after the full audit and two of Gucci's reviews):

- **Every view measured** (`qa/ui-audit.mjs`, `qa/views.mjs` shared with `qa/buttons.mjs`, which now
  also opens Rerun, Ship it, Changes with a diff, Org, and starts each view from a clean page).
- **Accessibility to 0** in 426 views: Settings' tabs, the harness picker's lists and Run on hold only
  what their roles allow; every switch, list, field and dialog × has a name; transcript steps no
  longer nest a button; links in sentences are underlined; removed diff lines don't fade.
- **Five sizes everywhere**: Settings' headings are one display size (18px); a bare `<small>` is
  11.5px; 10.5px badges joined the scale.
- **44px in the app**, every control, without moving layouts (negative margins, transparent borders on
  switches so they keep their 34×20 look).
- **The task's bar** says its actions' names wherever the details column doesn't fit (phone, narrow
  window, side panel open); on a phone it's one row and More leads with what it folded away.
- **Goal band**: never full before met; a pause says why without repeating the check.
- **Reply box** keeps its bar side by side (no 30px jump of what's above it).
- **First run**: New task is the prompt, mode, harness and Send, with More options; tips don't point
  at what it hides; it waits for the task list, so a returning user's box never loses its buttons.
- **New on existing surfaces**: comments on diff lines; an editor for a task's files (Edit here,
  Open file…, Save that refuses while the agent works or when the file changed); ⌘K searches inside
  prompts and answers.
- **One name per action** everywhere: *Changes*, *Shell*, *Take over*, *Transcript*.

## Still to watch

- Round 5's notes are done (goal band, check line, reply box) except the trail's result title at
  desktop widths: each turn's own result title, the same only in the QA wisp's fake answers.
- Round 7's: the phone task's chrome (~430px with a goal), the app's last card possibly under the
  Overlaps strip, ⌘K's full-text hits after the fuzzy ones (they come later and are appended, so
  nothing moves under the pointer), and a desktop comment card that sits in the margin beside the
  diff (on purpose: every line stays in reach for a shift-click).
- Home's Needs you repeats the sidebar's titles side by side. It's the inbox by design (it must
  list what needs you above the tips); its rows say nothing else twice.
