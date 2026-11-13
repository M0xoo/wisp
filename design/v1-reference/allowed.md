# Allowed differences between v1 and v2

`qa/parity.mjs` holds v2 to `design/v1-reference/` pixel for pixel and metric for metric
(`design/foundation.md` §3). These are the **only** differences it lets through, each one a fix the owner
already decided. Anything else that differs is a bug in v2, or needs the owner's say and a line here.

## 1. Bars never wrap (`design/layout.md`, ADR-0012)

Where v1 let a bar wrap its row or its labels (the composer's toolbar putting "Full auto" on two lines,
the top bar's memory chip pushing the avatar down), v2 keeps the bar on one line and collapses items
label → icon → More instead. So for the bars below, **when v1's bar is taller than v2's** (v1 wrapped,
v2 didn't), parity skips the metrics of the bar and of every element inside v1's bar box, and masks the
union of the bar's v1 and v2 boxes in the pixel diff. When v1's bar is one line, it must match exactly.

What parity still checks for them: `qa/layout.mjs` (one line, token height, no item on another row,
pinned items visible).

## 2. Every action answers at once (`design/feedback.md`, ADR-0017)

Where v1 showed nothing after an action, v2 shows the result, navigates, or puts the pressed control in
its pending state (spinner in place of the icon, same width, disabled). A control in its pending state
(`aria-busy="true"` or `data-pending`) is skipped by the metrics diff and masked in the pixel diff. The
reference shots are taken at rest, so this only applies to a view captured while something is in flight.

## 3. Glyph rasterization (the owner's call, 2026-11-08)

The same text in the same box can come out antialiased a pixel column differently in v1 and v2 (a
glyph's subpixel phase, e.g. the last letter of a pill that starts at x = 246.328). `qa/parity.mjs`
lets a differing region through when it is no larger than one glyph (6 × 10 px) **and** every metric of
that shot matches v1 exactly (each part's box within 0.5 px, font, colour). A larger region, or any
metric off, still fails. This is in the gate's code (`GLYPH_W`, `GLYPH_H`), not a rule below.

## 4. Bars fold at 320 px instead of wrapping (the lead's call, 2026-11-08)

At 320 px v1 wraps some bars onto a second line: the launcher's location row (*Other folder* drops
under the project pill), and a task's action bar (*Mark done* breaks into two lines, so the bar and the
Changes fill grow 5 px). v2 keeps ADR-0012's rule there too: the bar stays on one line and its items
fold to their icon, then into More. The lead decided this is v2's behaviour at 320, not a bug.

So on a shot **320 px wide or less**, for a bar named by a `fold` rule below, when v1's bar is taller
than v2's, `qa/parity.mjs`:
- masks the bar, and skips what v1 drew inside it (including items v1 pushed past the viewport);
- compares everything **below** the bar with v1's positions moved up by the height v2 saved, in the
  metrics and in the pixels (those rows are cut out of v1's shot); a box around the bar is that much
  shorter unless its height is fixed;
- **only when the layout gate passes on that same v2 page** (`qa/layout.mjs`'s checks, run in the page:
  no control text on two lines, no bar taller than its token or on two rows, nothing past the
  viewport, no pinned item folded). If the gate finds anything, the fold isn't allowed and the shot is
  diffed as is, with the reason in the summary.

Everything else at 320 still has to match v1: content text (a heading, a prompt) wraps as v1 wraps it,
and a pill or title is never cut shorter than v1 cuts it.

## 5. The owner's decisions

A difference the owner chose on purpose, named here with its commit. For the part a rule names, `qa/parity.mjs` masks
the part's box (v1's and v2's) in the pixel diff, skips the metrics of the part and of everything inside it, and counts
the generic parts (`x.button`, `x.heading`, …) again on both sides without what's inside it, so the decision doesn't
shift every later index. Everything outside the part still has to match.

- **One project selector instead of the chips** (the owner, 2026-11-12, commit 10d8f30f): the sidebar's project chips
  are one selector with a ⌘P switcher (search, ↑↓ Enter, colour dots, need-you counts, ⌘0–⌘9).
- **Take over is Open in <harness>** (the owner, 2026-11-09, ADR-0033 "Name"): the task's details say "Open in Claude
  Code" where v1 said "Take over" (`details.openIn`).
- **Settings-row titles never wrap** (the owner, 2026-11-12, round 26; ADR-0012, `design/layout.md` §1: settings-row
  labels are control text): at 390 v1 put Privacy's "Ask before a repo’s hooks, servers and setup run" on two lines;
  v2 keeps it on one, reworded to "Ask before a repo’s hooks and setup run" so nothing is cut. The row is 20 px
  shorter, so the row under it (Hide .env values) sits 20 px higher: both are masked at 390 only. Every other width
  is checked as before.
- **Install, not Review** (the owner, 2026-11-12, round 26): Settings → Plugins' box installs at once, switched off,
  and shows what the plugin asks for before you switch it on; v1's Review read a spell first. The shorter word makes
  the box beside it wider (`settings.spells`' one generic input).
- **Folder…, not File…** (the owner, 2026-11-12, round 26): a v2 plugin is a folder, so v1's File… (a spell's JSON) is
  a folder picker: the desktop app's own dialog, in a browser the box with the server's folder suggestions. Its
  label is longer, and the foot's "Turn every plugin off" says plugin (ADR-0031). Not masked: at 390
  `settings.spells` keeps those two buttons' widths (and a sub-pixel the box above leaves) as its known parts off.
- **Pin and Mark read in a task's menu** (the owner, 2026-11-12, round 30): v2 keeps them, after every one of v1's
  entries (v1's taskMenu had neither), so the row menu is two items longer than v1's: masked in task.right-click.

## 6. Known, not allowed: the list rows' glyph phase (the coder, round 25, 2026-11-12)

Recorded, not masked: parity still counts these regions. On home, palette and task at 1440 the left list's 2nd and
4th rows (the status pill's text, the harness · computer line, the dot) differ in regions a little over 8×8. Measured
live against v1 (origin/main, its QA seed restored): every box and every text node's rect in those rows is v1's to
1/64 px (rows 78.515625 px, the run line at 325.03125, the pill at 304.84375), the computed font, smoothing, kerning
and letter-spacing are the same, and with `overscroll-behavior: auto` everywhere v2's layer tree is v1's (#document and
the main column only). The glyphs still land a pixel apart on rows whose top falls near a whole pixel. Not found yet:
the next step is a Chrome paint trace of one row on each side. Fixed on the way: v1's 1.55 line heights in the rows
(20.140625 / 19.375 px), the section heading's chevron margin and count weight, the palette's inline keys and 7 px dots.

## 7. Improvements over v1 (the lead's call, 2026-11-13)

A place where v2 does better than v1 on purpose. Each names its rule below and its test.

- **The Files block cuts a path in its middle, not at its end** (`block.files.path`; test
  `files_block_path_truncates_in_the_middle_so_the_name_stays_visible`, `packages/ui/test/blocks-files.test.tsx`).
  v1's `.b-files .path` was one span cut with an ellipsis at its end, so on a 320 px phone a long path lost the file
  name, the one part that says which file it is. v2 cuts the folder from its start (`…oing/a-file.tsx`) and keeps the
  name whole until the folder is down to `…/`, the way v1's own Changes panel already did; CSS only (the Changes
  panel's `direction: rtl` folder with a `<bdi>`), no measuring per row. A path that fits renders exactly as v1's, so
  only a path that overflows differs: its box is masked (an `owner` rule), everything around it is still checked.

## Rules (read by `qa/parity.mjs`)

One rule a line: `<view glob> <part glob> <kind> [widths]` (widths: `390` or `320,390`; none means every width). `wrap` is §1, `pending` is §2, `fold` is §4
(320 px only), `owner` is §5. Nothing else is accepted: a rule of another kind fails the run.

```rules
*   topbar             wrap
*   topbar.*           wrap
*   launcher           wrap
*   launcher.*         wrap
*   composer           wrap
*   composer.*         wrap
*   split.head         wrap
*   split.actions      wrap
*   panel.head         wrap
*   stuff.filters      wrap
*   *                  pending
*   launcher.projects  fold
*   split.actions      fold
*   split.head         fold
*   panel.head         fold
*   topbar             fold
*   topbar.projects    owner
task*  details.openIn  owner
settings.privacy  settings.projectAsk  owner  390
settings.privacy  settings.maskEnvFiles  owner  390
settings.spells  x.input  owner  900,1440
task.right-click  list.menu  owner
task.right-click  list.menu.*  owner
*   block.files.path   owner
```
