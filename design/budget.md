# Plan budget and Wait for the reset

The week's loudest complaint (r/ClaudeCode, 2026-10): plans run out with no warning, and a task
that hits the limit just fails. wisp now shows how much of each account's usage windows is gone
and can let a task wait for the reset instead of stopping.

## Where the numbers come from

wisp reads what the CLI already reports on every run (two exceptions, Codex only: *Check Codex
while work waits* and the read before held-back work, both under **Live read** below):

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
*Used up · resets 21:00*, *New window*. A Codex account with banked resets has one more line under
its bars (`.bg-bank`, spell part `budget.banked`): *1 banked reset, expires tomorrow 17:00*, *3
banked resets, the next expires Thu, Nov 12, 09:00*, or just *2 banked resets* when Codex gives only
the count; `--warn` once one expires within a day. Before any run: *Shows each account's 5-hour and weekly
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

## Machine load

The owner had to restart a 24 GB Mac with 14 crew runs, their delegates and their own tasks going
at once (2026-11-07): wisp had no limit on concurrent runs. Memory is what limits coding agents,
not CPU (HiveMind, AgentCgroup): a `claude` CLI is about 300 MB, the tests and builds it runs reach
2–4 GB. So wisp admits held-back work only when the machine has room, the way Automations stop at
admits it only when the plan has.

- **Readings** (`server/load.js`, `app.load`), every 10 s on an unref'd timer, read synchronously:
  - macOS: `sysctl -n kern.memorystatus_level` (the free percent `memory_pressure` prints, no root),
    else `vm_stat` (free + inactive + speculative + purgeable pages). Never `os.freemem()` there: it
    counts free pages only and always reads low.
  - Linux: `MemAvailable / MemTotal` (`/proc/meminfo`), and `/proc/pressure/memory` `some avg10`
    when the kernel has PSI: 25% or more stalled holds even with memory free, under 10% clears.
  - Windows: `os.freemem() / os.totalmem()`.
  - CPU: `os.loadavg()[0] / os.availableParallelism()`; Windows has no load average, so the busy
    share between two `os.cpus()` samples (0–100%, so only the 100% ceiling bites there).
- **Settings** (spell-lockable, `SETTINGS` in spell-schema, refused otherwise): `memoryFloor`
  (`off` | `10` | `15` | `20` | `25`, 15), `cpuCeiling` (`off` | `100` | `150` | `200` % of the cores,
  200, held only after 60 s over: macOS's load average also counts processes waiting on I/O, and
  during a test suite an 8-core Mac read 118, about 1,450%), `maxRuns` (`off` | `4` | `6` | `8` | `12` | `16` | `auto`; auto is
  `floor(totalGB / 3)`, at least 2: 8 on 24 GB).
- **Hold**: `app.reserve.check` is `app.load.hold() || app.reserve.plan(…)`, so the same work waits,
  through the same paths as the table above, and the crew's hold checks it for members on Auto too.
  The hold is `{ load: true, kind: 'memory' | 'cpu' | 'runs', why, until }`: `until` is a minute on
  (there's no reset to wait for), so a held follow-up or goal round looks again then and a check-in
  or trigger runs at its next time. `load` goes on `m.held`, `t.held` and `l.held`, and the page
  says *Waits for the computer* instead of *for your plan*, with the why: *Waiting for memory: 11%
  free, needs 20%*, *Waiting for the CPU: load at 230% of its cores, needs under 200%*, *Waiting
  for a run slot: 8 runs going, at most 8*.
- **Hysteresis**: memory holds under the floor and goes on at floor + 5 points; the CPU holds after
  60 s over the ceiling and goes on once under it; a run slot is free as soon as a run ends.
  `app.reserve.plan` stays the plan's alone, so an early reset (`planFree`) isn't blocked by load.
- **Never held**: what you start or follow up by hand (it runs; under the floor the page gets a
  `load` event and toasts *Your Mac is short on memory: 12% free, 9 runs going*, once a minute),
  answers, Stop, and subagents and delegates of a running task (a lead would deadlock). Every live
  handle (`runner.live`) counts toward `maxRuns`, theirs included.
- **Seen**: Settings → Usage → **Machine load** (`.sx-load`, spell part `settings.load`): *Now* (free
  memory, CPU, runs of the limit, and the why while it holds, `GET /load`, read every 10 s while
  Settings is open) and the three selects.
- **`busy()`**: true while memory is under the floor or the CPU is over its ceiling (not for full run
  slots: a sweep costs disk, not a run); the worktree sweep and its `du` wait for the next hour.
- Off under `node --test` (the suite runs on CI boxes of every size); `test/load.test.js` turns the
  server's on with readings it sets.
- NOT NOW: pausing or killing running agents, cgroups, per-run memory limits.

## Paused, on battery, and what each task costs

`server/machine.js` (`app.machine`, design/machine.md for the API the page reads) adds two holds in
front of the readings, through Load's `extra()`: they hold the same work, through the same paths,
and hold even when the readings are off (you asked for them).

- **Pause automations**: `POST /automations/pause { until }` sets `defaults.automationsPausedUntil`
  (ms, at most 30 days on; `0` resumes). Kind `paused`, *Automations paused until 20:00* (*tomorrow
  08:00*, *Mon 08:00*). Its `until` is a minute on at most, so Resume now lets held work go within
  one. It expires by itself. A time isn't a choice, so it isn't a spell setting.
- **Battery** (macOS, `pmset -g batt` once a minute): on battery and under `batteryHold` (`off` |
  `20` | `40`, 20, spell-lockable), kind `battery`, *Waiting for power: battery at 14%, needs 20% or
  the charger*. The charger lets it go.
- **What each task costs**: one `ps` per 10 s tick (Windows: one `Get-CimInstance Win32_Process`),
  only while a run goes, for 3 min after one ends, or for 30 s after `GET /machine`. A run's tree is
  the runner's child pid and what's under it; `WISP_TASK=<task id>` is on every run's env
  (`runEnv`, every adapter) and a pid seen in a tree keeps its task, so a reparented process is
  still known. `GET /machine` has RAM/CPU per task and crew member, and the processes finished runs
  left behind (`POST /machine/stop { pid }`: SIGTERM, SIGKILL 5 s later; only those and pids in a
  running task's tree, never wisp or what started it).
- **On the card**: a running task's summary carries `res: { rss, cpu }` over 500 MB or 50% CPU,
  re-sent only when one moved by 20%.
- **A day of points**: every minute `{ at, freePct, cpu, runs, held, worktreeBytes }`, 24 h kept in
  `<home>/machine-history.json` (written every 5 points and at shutdown).

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
  a row in home's `.sh-spare` box after the spare rows (`.spr-card.wn-card`: logo, line, ×; at most
  two, newest first). Setting `windowNotice` (on unless off, spell-lockable), Settings → Usage →
  *Window changes*.
- **Terms.** Advice only: no action button, nothing switches.

## Allowance per window

People say a plan's percent buys less than it used to, and can't show it (the same complaint Drain
watch hears over hours, here over weeks). `GET /usage/periods` and `wisp.usage.accounts()` give the
Allowance board each window's periods; `server/allowance.js` is pure and reads tasks and
`budget.json`. On demand only, never on `GET /agents`: it scans every turn. A diagnostic: nothing
fires an event, notifies or touches a hold, and no setting is needed.

- **Closed periods.** `Budget.record` keeps `acc.periods[id]`: `{ resetsAt, ms, used, cut? }`, 40 per
  window, when a report's reset isn't the same period as the last one's. *cut*: it ended before its
  reset (an early or moved reset), so its reading isn't a whole period's. Runs at the same time can
  report out of order, so a period can close twice: the higher reading stands and a real close
  clears *cut*.
- **`used` lands only from this version on.** Older periods are known from `turn.plan` alone, so
  they show in-wisp only (`used`, `outside` null) and can't count to a reading. A window past its
  reset with no report since is still in `acc.windows`: it counts as closed.
- **Outside wisp first.** `outside` = `used` − `inWisp`. `inWisp` sums the plan shares, capped at 1
  and at `used`: shares can sum past `used` (concurrent reports each count a move), so outside can
  read low, never high.
- **Work is every turn on the account** with `startedAt` in the period, not the turns with a plan
  row: shares land on whichever turn is there when a whole percent ticks, about a third of them. A
  cut period stops where the next began, so turns after an early reset don't count twice.
  A period with no reading counts only from its first turn with a plan row: `turn.plan` can begin
  partway through one, and all its work over a share traced at its end reads as a huge cost.
- **Turn cost** (`turnCosts`). Claude: `stats.costUsd` with `stats.totals`. Older turns kept the
  running total in `costUsd` (#602), so the cost is the difference inside the task. Codex: tokens
  in millions (`unitsOf`'s formula), also as a difference, because `turn.completed.usage` is the
  thread's total and a resume carries it on (`codex-rs/exec` `usage_from_last_total`, seen in real
  `codex_exec` rollouts). A lower total means the counters started over: the turn counts in full.
  Differences are `rough` and show as ≈. Forked and shared turns and `stats.baseline` update the
  total but give no work: they're copies, or have no cost of their own.
- **`per1`** = work per 1% of the window, null under 5% in wisp: one rounded percent would swing it.
- **`full`**: closed at its reset, with a reading, the window's own length, and wisp was reading the
  account before it began (`acc.shape.since`). Anything less isn't a whole period to compare.
- **The reading** (`shrinkOf`, weekly windows only): the full periods with `per1` and at least 10% in
  wisp, newest first. Under 4: null, and the row says nothing. Two against two, so one odd week
  can't speak; each side is its work over its share, so a big week weighs more than a small one. At
  −20% or lower *less*, +20% or higher *more*, else *same*.
- **A plan change** (`PLAN_CHANGE`, Codex only: 1 December 2026 to 1 January 2027): Plus, Pro and
  Business share one allowance with ChatGPT then, chats move the window and `#sharers` can't tell
  them apart, so 1% before and after aren't the same 1%. OpenAI says *starting in December* and names
  no day, so the whole month is the change. Once a fair period ends after `from`, only periods
  wholly past `to` count: Shrink says nothing until there are 4 of those. Period rows stay. If it
  slips past December, move `to`.
- **What moved in the CLI** (`cli`, from `stats.cli`, which only newer turns have): optional, read
  with care, and a field counts only with both sides known. No data, no key. A reading says the
  moves across its sides, and only when it isn't *same*: a cause to look at, not a verdict.
- **A starter nobody changed follows wisp's.** A starter is copied once, so a board added earlier
  would never get this. `wisp-app.json`'s `was` lists folder hashes wisp shipped (`appHash`, oldest
  first; a change to a starter appends the hash it had). At boot a copy with one of them updates
  through the normal path: rev + 1, prev kept, title and grants as they were. Any other hash was
  changed by you or an agent and stays. So does a copy you went back to with Restore.

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
  to spend.
- **Banked resets** (`codexBanked`): the same answer's `rateLimitResetCredits` (`availableCount`,
  `credits: [{ id, expiresAt, status }]`, `null` when only the count is known, possibly capped).
  Kept as `acc.banked = { count, credits, at }` until the next read; credits past `expiresAt` or not
  `available` drop out of the count (`bankedAt`). The phone hears once per credit id, the day before
  it expires (`liveLimits.noteBanked` every tick, `Budget.bankedDue` / `bankedSent`, from the last
  reading, so it reads nothing); a note that couldn't go (no ntfy or Telegram) isn't marked sent.
  No card, no hold, no button: wisp never redeems one, and never reads `~/.codex/auth.json`. Claude Code has no free read (its `rate_limit_event` comes only inside a model call, and a
  private OAuth endpoint with a scraped token is off-limits): it keeps learning with its next run.
- **Read before held-back work** (`liveLimits.before`, `app.reserve.fresh`): with an Automations
  stop line on Codex, an unattended launch, a follow-up nobody sent by hand (a pass ahead of
  `Later.tick`'s loop), a trigger's follow-up to an open task and a goal's next round read the
  account first when its reading is over 15 minutes old (no reading counts as old). At most one read
  per account per 15 minutes, failed ones included (`tried`, which `tick` sets too), and callers at
  once share it. It needs no switch and ignores `defaults.liveLimits`, which governs the polling: it's
  a single read, only when you've set a stop line and work is about to start, it spends nothing,
  and without it a line meant to protect your chats would read old numbers. A failed read warns and
  changes nothing: the work goes on what wisp knew. A reading past the line only feeds the silent
  waits above: no card, no new hold. `reserve.check` stays synchronous and never reads (`Crew.view`
  calls it on every render). Hand-started runs never read, and the review gate
  (`services/review.js`, whose `maybe()` is synchronous) isn't covered.
- **`record(…, { read: true })`**: both kinds of read pass it. A read is no run's report, so what
  moved since the last reading doesn't land in `acc.learn` or `acc.run`: it may be chats, and Ask near
  the limit and Drain watch would charge it to the next run.
- **Frozen entries** (`codexLive`): if OpenAI moves the limit to a new id, `rateLimitsByLimitId.codex`
  may stay with its old numbers. An entry with a reset over 5 minutes in the past is frozen (a live
  answer never reports a reset that's gone), and `rateLimits` or the other entry with the latest reset
  takes over, never a model's own bucket (`normalModelSlug`) or `premium`. None: the codex entry,
  as before. A frozen entry is only caught once one of its resets passes: up to a week on a plan
  with no 5-hour window.
- **A plan with no 5-hour window** (secondary sources say Pro, OpenAI hasn't confirmed): the weekly
  window may come in either slot, and a slot with no length is skipped. One bar; `hold`, the reads and
  Shrink need nothing else. An account that loses the window is told once as *gone*, never as a length
  change. Until its reset, the old window's last numbers stand and can hold work: at most 5 hours.
- **Terms**: reads the account the work would run on and nothing else; never switches accounts or
  spends a reset.

## Usage receipt and Past your plan

Each finished turn's trail bar carries a quiet receipt (`web/js/receipt.js`): tokens read and written
(Anthropic's cache reads and writes are counted apart from `input_tokens`, OpenAI's `input_tokens`
already holds the cached ones), the share that came from the cache, and the turn's share of the
account's **longest** window (`turn.plan`). With Claude's 5-hour window gone on some plans, people
count the week, so the week leads. The plan share lands with the account's next report, so a turn
that just ended may show it a little later. Nothing shows while the turn runs.

*Past your plan* marks a run billed beyond the plan: Claude Code's `rate_limit_info.isUsingOverage`
(extra usage), a drop in Codex's `rate_limits.credits.balance` between two reports (credits), or
Claude Code's `apiKeySource` other than `none`/`oauth` (an API key, shown as *API credit*), or a
`Profile:` line in `claude auth status --text` (a Console sign-in, shown as *Console sign-in*). It sets
`turn.overage` once per turn, and Plan budget lists the account's count for the last 7 days with
*Open it* for the last task (`overage()` keeps 50, for a week). It's a fact about billing, in the
warn colour, never a block: wisp doesn't stop the run or switch accounts.

**Console sign-in.** With the claude.ai login ended (or `ANTHROPIC_PROFILE` set), Claude Code runs on
an `ant auth login` or keyless Console profile and bills the Console org. Its stream-json says nothing
(`apiKeySource` is `none` for a login and a profile alike) and it keeps its own warning off in that
format, so the CLI's public `auth status --text` is the only sign: wisp reads it as a task's turn
starts, at most once a minute per account folder (`consoleProfile()` in `server/adapters/claude.js`),
beside the run and cut off after 5 s. A failure or a timeout reads as the plan, and so does a
`Profile:` line ending in `· not in use` (an API key outranks it: that run says *API credit*). The answer can land
after a quick turn ended; the turn still gets its mark. Words: the turn says *Console sign-in*, its
tooltip *Billed to a Claude Console org, not your plan: Claude Code ran on a Console profile …*, Plan
budget *billed to a Console sign-in, not the plan*. Never a hold, an ask card or a delay, in any mode;
wisp never reads Keychain, token files or auth stores to find out.

An account whose reports list only a weekly window has no 5-hour row. A window the latest report of
every window left out stops showing once its own reset has passed (no empty bar), and the
window-change notice says *gone* once, after `GONE_MISS` reports over `GONE_AGE`.
