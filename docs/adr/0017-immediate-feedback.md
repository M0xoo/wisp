# ADR-0017: Every action answers within one frame

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "an action happens and there's no immediate feedback; the user should always feel the
  app is responsive."

## Decision

`design/feedback.md`: within 100 ms of any user action the screen visibly changes: the optimistic result,
an immediate navigation with a skeleton, the new thing appearing where it goes, or the pressed control's own
pending state. Commands must declare `optimistic` or `pending` (a type error otherwise); kit controls bind to
commands and show their pending state themselves; `navigate()` never waits on data; rejections always roll
back with a toast. `qa/feedback.mjs` clicks every control in every view on a slowed network and fails on
any action with no visible change within 100 ms.

## Consequences

This is a deliberate change from v1's behaviour (v1 had actions with no feedback), so it's listed in
`design/v1-reference/allowed.md` as an allowed difference from the parity gate: a pending state may appear
where v1 showed nothing.
