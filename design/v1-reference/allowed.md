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

## Rules (read by `qa/parity.mjs`)

One rule a line: `<view glob> <part glob> <kind>`. `wrap` is §1, `pending` is §2. Nothing else is
accepted: a rule of another kind fails the run.

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
```
