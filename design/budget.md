# Plan budget and Wait for the reset

The week's loudest complaint (r/ClaudeCode, 2026-10): plans run out with no warning, and a task
that hits the limit just fails. wisp now shows how much of each account's usage windows is gone
and can let a task wait for the reset instead of stopping.

## Where the numbers come from

wisp reads what the CLI already reports on every run (the one exception: *Check Codex while work
waits*, below):

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

## Spare allowance

People lose the share of a weekly window they didn't use when it resets, or when they downgrade
(r/ClaudeCode 1xm7meb, r/codex 1xm7zvm, 1xm8jsu). Moris's pick, 2026-11-02. Page only, no route:
the numbers are already on `GET /agents` (`budget`).

- **Rule** (`web/js/spare.js`, `spareOf(agents, { now, hours, left, seen })`, DOM-free): a window of
  a day or more (`ms`) whose reset is within `hours` (24; spell prop `split.spare.hours`, 1–40)
  with at least 20% left, on an installed harness. Not when the window runs out first at this pace
  (`hitAt`), when any window of the account is used up (a task now would only wait), or for an
  account since removed. The 5-hour window never counts: it always resets soon.
- **Row** (`split.js paintSpare`, `.sh-spare` under Needs you so Needs you never moves when the
  numbers arrive; at most two, soonest first; no surface until hovered, like `.sh-task`): the
  harness logo, ***38%** of Codex’s weekly window left · resets Thu 21:00* (weekday and time; the
  tooltip has the date and when the CLI last reported), **Use Codex** and ×. On a phone the line
  wraps and the button goes under it; 44px targets in the app. Repaints on the `agents` bus event.
  Reviewed for UI by a stand-in for Gucci (2026-11-02): quieter rows, under Needs you, *Use …*
  rather than *Start a task* (nothing starts), phone layout.
- **Use <harness>** sets the launcher's harness and account (`#launcher.spellSet({ agent, account })`,
  the same `pickRun` as the picker, so it's saved as the harness's account like a pick by hand) and
  focuses the prompt. Nothing is sent.
- **×** keeps `wisp.spareSeen[agent:account:window] = resetsAt` in this browser; the same period
  (within 10 minutes, Codex drifts) stays hidden, the next one shows. Past resets are pruned.
- **Setting** `defaults.spareCard` (`on` | `off`, on unless off, spell-lockable), Settings → Usage →
  *Spare allowance*.
- **Terms.** Advice only. It never switches accounts, never moves work, never spends a banked reset
  (`rateLimitResetCredit/consume` stays unused).


## Window changes

Plans change their windows without saying so: a weekly reset that moves from Thursday night to
Sunday morning, a weekly window that becomes a 30-day one, a window that's added or dropped. People
plan their week around those resets. Moris's queue (#5), 2026-11-03.

- **Detection** (`server/budget.js` `#shape`, on every `record()`): what wisp last saw of each
  window (`acc.shape.windows[id] = { ms, resetsAt, slot, at, miss }`) is kept in `budget.json`, so
  a restart announces nothing again. The first report of an account only sets it.
  - *reset*: a window of a day or more whose reset is off its old schedule (old reset plus whole
    periods) by more than 10 minutes (Codex drifts). Never the 5-hour window (it starts at your
    first message), never an early (banked) reset (it has its own *Reset early* line).
  - *length*: the same id with another length, or Codex's same slot (`primary`/`secondary`) under
    a new id (Codex names windows by their minutes: `seven_day` → `w43200m`).
  - *new*: a window not seen before, from a report that lists every window (`complete`: Claude's
    `unifiedWindows`, Codex's rate_limits). A Claude event naming one window says nothing.
  - *gone*: missing from 3 full reports in a row over 6 hours or more. Its bar goes too.
- **Notices** (`acc.notices[window]`, one per window; the next change of it replaces it) are on
  `GET /agents` as `budget[].notices` with `label`/`wasLabel`, unless `defaults.windowNotice` is
  `off`. × is `POST /agents/:id/windows/dismiss { account, window }`, optimistic with a `tryApi`
  rollback (`features/budget.js dismissNotice`), shared by both places.
- **Words** (`web/js/window-notice.js noticeWords`): *Codex’s weekly window now resets Sun 09:00
  (was Thu 21:00)*, *… is now 30-day, resets …*, *Codex has a new 30-day window, resets …*,
  *… is gone: it no longer reports one*. Weekday and time; the tooltip has the dates and when wisp
  saw it.
- **Where**: a line in the account's block in Settings → Usage (`.bg-note`, under the bars), and
  a row in home's `.sh-spare` box after the spare rows (`.sp-card.wn-card`: logo, line, ×; at most
  two, newest first). Setting `windowNotice` (on unless off, spell-lockable), Settings → Usage →
  *Window changes*.
- **Terms.** Advice only: no action button, nothing switches.

## Not yet

- Asking before a run takes a window past a line: design/hold.md (Ask near the limit).

- Budget of tasks on other machines (each machine keeps its own `budget.json`).
- Auto at a limit with nothing else to run doesn't wait yet: it settles and the card asks.
- A launch onto an account that's used up could offer *Start at the reset* (Later plan).

## A line per harness

ChatGPT and Codex are moving to one shared allowance (OpenAI's email, 2026-10-31; HN 50320588,
r/codex 1xku32u, codex#58530), so people want unattended Codex runs to leave some for their chats.
`defaults.autoStopClaude` / `autoStopCodex` (`same` | `off` | `50` | `75` | `90`; unset is `same`)
override `autoStop` for that harness: `stopFor(defaults, agent)` (`server/budget.js`, `STOP_KEYS`),
used by `app.reserve.check`. A harness with no row follows `autoStop`. Settings shows a row for each
reporting harness that's here (`.us-by-row`), and each account's bars mark its own line
(`.bg-acct.stops`, `--stop`).

## Drain watch

People see a plan suddenly empty faster for the same work and can't prove it (r/ClaudeAI 1xh3yyu,
r/cursor 1xkubzj, codex#58520). `defaults.drainWatch` (`on` | `off`, off by default).

- **Samples.** `record()` adds a close reading's move to `acc.run[id]` (the same moves Ask near the
  limit learns from); `spend(agent, account, units, { failed })` closes it as one run:
  `acc.drain[id]` keeps `{ at, du, units, failed? }`, at most 40 per window, two weeks. Runs at the
  same time share the move between two readings: the first to end takes it, which evens out.
- **`drain(agent, account)`**: per window, the runs of the last two hours against the ones before
  (within two weeks). Usual needs 5 runs and 3 points moved, recent 2 runs and 5 points (the CLI
  reports whole percents). At 2× or more the usual share per unit, the fastest window:
  `{ id, label, ratio, since, runs, units, du, usual, failed: { runs, du } }`. Units are Claude
  Code's reported cost, else tokens (`unitsOf`), so a ratio only compares an account with itself.
- **Dismiss** (`POST /agents/{id}/drain/dismiss { account, window }`) stores `drainSeen[id]`; the
  card stays hidden until a run after it.
- **Where it shows.** `Budget.view` carries `drain`; `/agents` drops it unless the switch is on. The
  card sits in the account's block (`.bg-drain`), with Copy report (`drainReport`, UTC times, for a
  ticket) and Dismiss (optimistic, rolled back with a toast). `onDrain` sends the phone
  `drainWhy()` at most every two hours per window, when ntfy or Telegram is on.
- **Terms.** It only reads what the CLI already reports and changes nothing about where runs go.

## Early resets

OpenAI hands out banked Codex resets with no notice (r/codex 1xkq1f9, 1xkapax; codex#58520). Held
work used to wait for the old `resetsAt`, because nothing runs while held to tell wisp otherwise.
Design by Sana (2026-11-01).

- **Seen**: `resetEarly(was, next, now)` in `Budget.record`: the old reset hadn't come, the new one
  is more than 10 minutes later, and `used` fell by 0.25 or more (or under 5% from at least 10%).
  Codex's drifting "in n seconds" alone never counts. `acc.early[id] = { at, resetsAt }`; the view
  gives `earlyAt` while it's the same period (*Reset early 10:12 · resets …*). `onReset(agent,
  account, ids)`.
- **Released**: `app.resetEarly` (server/index.js), only when nothing holds the account now
  (`reserve.check` null and no full window): `Later.pullForward` brings due a held follow-up
  (`held`, on the task's own account), one waiting at a limit (`limit: { agent, account }`, set by
  `runner.waitAtLimit`) and a held run (`turn.held.until`); the next tick checks again before it
  sends. `Crew.release` / `Triggers.release` drop `held` (now with `agent`) so the rows stop saying
  skipped. The phone hears `↻ Codex reset early` with the count.
- **Live read** (`server/live-limits.js`, `defaults.liveLimits`, off by default): every minute a
  tick looks at each Codex account (`accounts.list`, its own `CODEX_HOME`) with work waiting on it
  (`waitingOn`), at most every 10 minutes: `codex app-server`, `initialize`, `account/rateLimits/read`,
  then the process goes (15 s timeout; on errors back off ×2 up to an hour). `codexLive` maps the
  answer (`rateLimitsByLimitId.codex`, camelCase) to `codexLimits`, and `Budget.record` does the rest.
  Nothing waiting: no traffic. Never `account/rateLimitResetCredit/consume`: a credit is the user's
  to spend. Claude Code has no free read (its `rate_limit_event` comes only inside a model call, and a
  private OAuth endpoint with a scraped token is off-limits): it keeps learning with its next run.
- **Terms**: reads the account the work would run on and nothing else; never switches accounts or
  spends a reset.
