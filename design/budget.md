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

## Automations stop at

Users leave check-ins, triggers and goals running overnight, and wake up to an empty plan (CC
#105111, r/codex 1xgm9xm). `defaults.autoStop` (`off` | `50` | `75` | `90`, off by default,
spell-lockable, refused otherwise) holds back **work nobody started by hand** while the account it
would run on has a window at or past that share. The work goes on at the latest reset among those
windows (`Budget.hold(agent, account, stop)` → `{ window, label, used, stop, until }`; a window
with no reset time holds nothing). `app.reserve.check(agent, account)` adds the words
(`holdWhy`: *Claude Code’s weekly window is at 81%, past your 75%*; the page adds the time).

| Work | Held where | What the user sees |
|---|---|---|
| Crew check-in on its schedule or a wake-up | `Crew.tick` → `launch(…, { unattended })` throws `held` → `#failed` | skipped; `m.held`, one log line for skips in a row (`skipped: n`), not counted; the page: *Waits for your plan · Thu 21:00*, the next check-in after the reset, Scheduled row *Check-in waits for your plan* |
| Trigger (schedule, GitHub watcher, task watcher), its crew job, its CI follow-up | `Triggers.fire` (not `manual`) | `t.held`, not `lastError`: *Skipped 4h ago for your plan · runs again after …*; a held GitHub item isn't marked seen, so a later poll picks it up |
| Goal round | `Goals.run` before the reply | the goal pauses with `held: until`; the round is a Later follow-up by wisp with `goal: round` and `held`; the task goes to `done` (Scheduled). At the reset `Later.fire` → `Goals.carryOn`. **Resume goal** sends that round now; Pause, Drop, cancelling the row or Mark done bring the task back to Needs you |
| Follow-up an agent / wisp / a crew member scheduled | `Later.tick` | moved to the reset with `held: { why, until }`; *Send now* still sends it; the next due follow-up (yours) goes in the same tick |

Not held: anything you start or schedule, *Check in now*, *Run now*, delegations (a lead waits on
them), subagents, members and launches on other machines
(each machine keeps its own budget).

## Where it went

`Budget.begin/end(agent, account, session, turn)` (runner `#startTurn` / `#finishTurn`, in memory)
keeps which turns ran on an account. On each report, a window's move since the last one (all of
it in a new period) is shared among the turns that ran in between, weighted by how long each ran
then (`onShare` → `addShare` → `turn.plan: [{ agent, account, window, used, resetsAt }]`). Moves
with no turn running are left untraced (outside wisp). Claude reports once per run, after its first
reply, so a turn's share mostly arrives with the next run's report. Codex reports at the end of the
turn.

- A summary carries `plan: { seven_day: 0.22, five_hour: 0.31 }` (`planOf`). The details column
  shows *22% of weekly · 31% of 5-hour* (`.plan-used`, spell part `details.plan`). The narrow bar
  leaves it out to stay at two rows.
- `GET /agents` budget blocks carry `where` for the longest window: `{ window, label, used, tasks:
  [{ id, title, used }] (top 3), more, traced }` (`whereItWent`; a subagent's share counts on its
  lead). Settings shows *Where the weekly window went*: the tasks (each opens), *n other tasks*,
  and *Outside wisp or earlier* (= used − traced). Spell part `budget.where`.

## Not yet

- Asking before a run takes a window past a line: design/hold.md (Ask near the limit).

- Budget of tasks on other machines (each machine keeps its own `budget.json`).
- Auto at a limit with nothing else to run doesn't wait yet: it settles and the card asks.
- A launch onto an account that's used up could offer *Start at the reset* (Later plan).
