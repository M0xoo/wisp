# Plan budget and Wait for the reset

The week's loudest complaint (r/ClaudeCode, 2026-10): plans run out with no warning, and a task
that hits the limit just fails. wisp now shows how much of each account's usage windows is gone
and can let a task wait for the reset instead of stopping.

## Where the numbers come from

Nothing is asked of the provider. wisp reads what the CLI already reports on every run:

| Harness | Source | Windows |
|---|---|---|
| Claude Code (2.1.309) | `rate_limit_event` in `--output-format stream-json`: `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`, `status: rejected` at a limit | 5-hour, weekly (Opus/Sonnet weekly when it sends them) |
| Codex (0.163) | `codex exec --json` doesn't print them. Its session file `CODEX_HOME/sessions/yyyy/mm/dd/rollout-…-<thread>.jsonl` has `rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at}` | named by length: 300 min = 5-hour, 10080 = weekly, else *30-day* … |

Adapters turn both into one event, `{ type: 'limits', windows: [{ id, used, resetsAt, ms }], rejected? }`
(`server/budget.js`: `claudeLimits`, `codexLimits`, `codexRollout`). Other harnesses report nothing
and show nothing.

## Server

- `Budget` (`server/budget.js`, `app.budget`, `runner.budget`) keeps `~/.wisp/budget.json`:
  `{ agent: { account: { at, windows: { id: { used, resetsAt, ms } } } } }`, account `default` for
  the CLI's own. A window whose reset has passed reads as fresh (0%, no time).
- **Pace**: `paceOf()` = when the window would be used up at the rate since it started
  (`resetsAt - ms`). Shown only when that's before the reset, at least 5% is gone and a tenth of the
  window (at most 30 min) has passed.
- `GET /agents` carries `budget: [{ account, at, windows: [{ id, label, used, resetsAt, hitAt }] }]`.
  A moved percent broadcasts `agents` (at most every 2 s); no new route.
- **Limit card on every harness.** `Runner.#atLimit` used to need several accounts. Now any usage
  limit (`infraError` scope `agent`) sets `turn.limit`; the reset comes from `Budget.resetAt()` (the
  latest reset among full windows) before the 6-hour guess from the error text. One account: the
  hero names the harness and offers *Wait until* and *Hand to …* only.
- **Wait for the reset** (`defaults.limitWait`, off by default, spell-lockable). At a limit, when
  Auto isn't holding the task (Auto moves it to another harness itself), `runner.waitAtLimit`
  schedules a Later follow-up by `wisp` at the reset (`LIMIT_CARRY_ON`, the same words the card's
  *Wait until* sends). The task goes to `done` + unread false, so it sits under *Scheduled*, and the
  hero says it carries on by itself. Later's limits still apply: an agent-side follow-up is a week at
  most and 10 in a row (`laterChain`), so a weekly reset fits and a loop of limits stops and asks.
  Subagents never wait (their lead does).

## Page

Settings → Usage → **Plan budget** (`.sx-budget`, spell part `settings.budget`): a block per
account (harness logo, name, the account's label when there are several), a row per window: label,
a 6px bar (accent; `--warn` at 90% or when the pace runs out first; `--bad` when used up), the
percent, and one line: *Resets Thu 21:00*, *Resets 15:00 · at this pace, runs out 13:40*,
*Used up · resets 21:00*, *New window*. Before any run: *Shows each account's 5-hour and weekly
windows after its next Claude Code or Codex run.* The **Wait for the reset** switch sits under it.

## Terms

Waiting stays within the provider's limit; wisp still never switches accounts because of a limit
(design/accounts.md → Terms). Reading the CLI's own output is not an API call.

## Not yet

- Budget of tasks on other machines (each machine keeps its own `budget.json`).
- Auto at a limit with nothing else to run doesn't wait yet: it settles and the card asks.
- A launch onto an account that's used up could offer *Start at the reset* (Later plan).
