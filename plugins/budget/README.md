# wisp.budget

Usage windows, Automations stop at, and the `before:run` guard (v1 `server/budget.js`).

## Intent

- Each account's usage windows come from what its runs report (`turn.limits`) or a live read.
- Unattended work (crew, triggers, goals, agents) on an account past its stop line is held; the user's own
  runs never are.
- Held work starts as soon as the account is free again: its windows reset, or a reading says they reset
  early.

## Not yet

Drain watch, window-change notices, banked resets' notes, overage, and the compare and allowance views.
