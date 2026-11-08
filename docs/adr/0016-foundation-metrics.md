# ADR-0016: v2 looks exactly like v1, proven by a pixel and metrics gate

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "I expect the UI to be exactly like wisp right now, EXACTLY." and "make the base good
  from the start."

## Context

The first v2 screens didn't look like wisp: the kit had tokens but chose its own paddings, rows had no fixed
columns, and gutters differed between bars. A draft of `design/foundation.md` then invented new metrics,
which was also wrong: the owner wants today's wisp, exactly.

## Decision

- v1 as it renders today is the visual spec. `qa/v1-reference.mjs` captures screenshots and computed
  metrics of every view, width, theme and state into `design/v1-reference/` before v1 is deleted.
- The kit reproduces v1's values, element by element. Unifying v1's one-off values is a later change, made
  only with the owner's say.
- `qa/parity.mjs` gates every screen: pixel diff under 0.5 % and metrics within 0.5 px of v1, on the same
  seeded data. The only allowed differences are the owner's own fixes (no wrapping bars), listed in
  `design/v1-reference/allowed.md`.
- The lead reviews v1 and v2 screenshots side by side for every screen before the next one starts.

## Consequences

The architecture changes; what users see doesn't. v1 has to stay in the tree until the reference is
captured and committed.
