# wisp.budget

Usage windows, Automations stop at, and the `before:run` guard (v1 `server/budget.js`).

## Intent

- Each account's usage windows come from what its runs report (`turn.limits`) or a live read.
- Unattended work (crew, triggers, goals, agents) on an account past its stop line is held; the user's own
  runs never are.
- Held work starts as soon as the account is free again: its windows reset, or a reading says they reset
  early (a banked Codex reset, once per period): the runs held here start, `budget.plan_free` brings due
  the follow-ups wisp.later holds for it, and the phone hears *↻ Codex reset early* with the count.
- Check Codex while work waits reads the accounts work waits on: runs held here, and accounts a run found
  at their limit.

## Not yet

Drain watch, window-change notices, banked resets' notes, overage, and the compare and allowance views.
