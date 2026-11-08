# ADR-0016: One set of exact metrics, enforced in Chrome

- Status: accepted
- Date: 2026-11-08
- Source: the owner, after seeing the first v2 screens: "spacing is bad, inconsistent paddings, sloppy
  patterns; make the base good from the start."

## Context

v1 had 157 distinct px values and no spacing scale. The first v2 kit had a token scale, but its components
still chose their own paddings, rows didn't keep fixed columns, and gutters differed between the top bar
(24), the list (10) and the right edge (20).

## Decision

`design/foundation.md` fixes every metric: a 4 px grid, a 12-step spacing scale with semantic names, one
gutter line per pane, a 7-step type scale, four control sizes, surfaces, bars, the list row's exact columns,
content widths and empty-state rules. The kit uses only these tokens. `qa/layout.mjs` measures the rendered
page against them at six widths, light and dark. No UI screen is built or accepted until the kit and shell
pass, and the lead reviews screenshots of each screen next to v1's.

## Consequences

Features never choose a number. A new need changes `design/foundation.md` first, in review. Some v1 screens
will look more regular than v1 did; that's intended.
