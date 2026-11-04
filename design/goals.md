# Goals

A goal is a condition a task has to reach before wisp lets it go: "all tests pass and /login
works on a phone". The agent works, wisp checks the goal, and while it isn't met wisp sends the
task back with what's still missing. The task lands in Needs you only once the goal is **met**,
**can't be met**, or it stalled. There's no cap on rounds: wisp keeps going until the check says so. Like Claude Code's goals, but for every
harness, and visible the whole time. Code: `server/goal.js`, `web/js/features/goal.js`,
`web/css/goal.css`.

## Words

- **Goal**: the condition. The UI says *Done when* where it shows or asks for one.
- **Round**: one run of the agent toward the goal. *Round 3*, shown in the band and the row.
- **Check**: wisp looking at the work after a round.
- States: *Working* · *Checking* · *Goal met* · *Can’t be done* · *Paused* ·
  *Moved on* (Auto handed the task to another run, which carries the goal). Goals saved before
  the cap went may still read *Stopped* (`out`); Resume carries them on.
- Actions, the same name everywhere (band menu, More, right-click, ⌘K): **Set goal…** /
  **Edit goal…**, **Pause goal**, **Resume goal**, **Drop goal**. Typed: `/goal <condition>`,
  `/goal` alone (opens the popover), `/goal drop`.

## Backend

`session.goal = { text, round, status, from, setAt, endedAt?, why?, checks[], fresh?, running? }`,
each check `{ turnId, round, verdict, why, next?, progress?, tests?, changed, at, run? }`.

- **Set**: `goal: { text }` on `POST /sessions` (a prompt that is just `/goal …` too), `/goal`
  in a follow-up, or `PUT /sessions/:id/goal`. On an idle task it's checked at once (it may already
  hold). `PATCH { action: pause | resume }`, `DELETE`. A `max` from an old client is ignored.
- **Hold**: `Runner#finishTurn` keeps the task in Working when Auto's pipeline wants it or, if not,
  the goal does. After Auto's steps, `runner.settle()` asks the goal before the task lands.
- **Check**: the project's tests first (Auto's run of that turn counts), then a cheap model
  (`quick.js`, read-only, in the task's folder) gets the goal, the task, the diff since the goal
  started (`from`), the test result, earlier checks and, last and labelled a claim, the agent's
  report. It answers `{ verdict, why, evidence[], next, progress }`. A `met` with failing tests or
  no evidence becomes `not_yet`. No model → paused, *couldn't check*.
- **Continue**: `not_yet` → a follow-up from wisp (`by: 'wisp'`, `turn.goal` = the
  round) with what's missing and what's next. Two rounds in a row that change nothing or get the
  same next step → paused, *stalled*: the only stop besides met and can't. Resume counts
  stalls from there on (`fresh`), so it gets at least one more round.
- **Moves**: your Stop → paused (a Stop during a check lands the task at once); your follow-up
  keeps the goal and drops a check in flight; an interrupt is not a Stop; a restart pauses it;
  Auto's hand-over gives the goal to the new run (`handed` here).
- **Judges**: `goal.judges = [{ agent, model, effort, name } | { crew, name }]` (up to 5) and
  `goal.vote = all | majority | any` (default majority). With judges, each runs the same check
  (`askJson` on its own harness, model and thinking level; a crew member on theirs, told its role)
  at once, and each check stores `votes[]`. Met: at least *all* / *more than half* / *one* of the
  judges say met. Can't be done: a majority say so. A judge that can't answer votes for nothing
  (so it holds back All); none answering → paused, *couldn't check*. The check's `why` is the tally
  (*2 of 3 judges say met (all must agree)*) and the first dissenter's reason; `next` joins the
  dissenters' next steps, by name. A PUT without `judges` keeps them; `[]` clears them.
- **Records** (`server/goal-runs.js`): every checker that ran gets one, a turn's shape in
  `~/.wisp/goal-runs/<task>/<run>.json`, filled from the same events (`askJson`'s `onEvent`, the
  runner's `stepOf`), `run` on its vote (or on the check, for wisp's own). Not a session: 5 judges
  over 50 rounds would be 250 tasks for every list, summary and start to walk, each save bumping
  the summaries' epoch. So they never reach the list, Needs you, ⌘K, notifications, usage or the
  crew. One that timed out, stopped or gave no JSON keeps what it got (`end`). A judge not installed
  or gone from the crew has none. 40 KB of prompt and the latest 200 steps / 120 KB per record; only
  what `checks` points at stays, so a goal keeps its last 50, and Drop goal or deleting the task
  removes them. Archive keeps them. `GET /sessions/:id/goal-runs/:run`, masked like a turn: a .env
  file's output has Reveal, its lines in the prompt's diff are masked. `goal-run` SSE events carry
  the steps of one under way; `goal.running` names those while it's `checking`.
- **Not for** subagents, delegates, crew jobs, spells, the tour.

## UX

- **Launcher**: *Goal* in the bar (icon only on a phone) opens a *Done when* line under the prompt.
  On/off and the text
  survive a reload; an empty line launches without a goal and says so in a toast.
- **Reply box**: *Goal* (the target, icon only) in its bar, after the team picker. No goal, or one
  that ended: it opens the launcher's *Done when* line between the message and the bar (*Add a
  goal* / *New goal*). Enter in the line, or Send, sets it: alone, or with the message (`goal` on
  `POST /sessions/:id/reply`, set after the reply so it's checked after that turn). A goal going:
  lit, and it opens **Edit goal…**. The open line keeps the folded box open; Esc closes it.
- **Judges** (`web/js/features/judges.js`): a *Judges* button at the end of the launcher's Done
  when line and in the Set / Edit goal popover, the Delegate button's look (faces and *3 judges ·
  All*, icon-only on a phone). Its popover: *Met when* All · Majority · Any with the rule in words
  (*2 of 3 must say it’s met*), a row per judge (the harness picker, or a crew member's face and
  role), *Add judge* (a menu with your crew when you have one), Clear. The launcher's picks are
  remembered (`defaults.goalJudges`, `goalVote`). In the band, after the condition: each judge's
  face tinted by its last vote (met green, can't red, no answer faded) and *2/3*; the tooltip has
  each judge's vote and why.
- **Goal checks** (`checksPopover`): from the band's faces, its check line (a button once there's
  a check, for a goal without judges too) and **Goal checks…** in the menus and ⌘K. Each judge's
  last vote and why, then *Earlier rounds*: a row per round with a tinted face per judge, each of
  which opens that judge's check. Without judges a row per round opens it. A row with no record
  (an old goal, a judge that never ran) isn't a link. During a check the rows say *Checking*, and
  open the run once it has started (*After the project's tests* until then).
- **A check's page** (`web/js/features/goal-run.js`): laid over the open task, on its box, so the
  task stays open and Back (the page's own, the head's, Esc, the phone's) finds it where it was.
  On top which judge, the round, the vote and the why, at once from what opened it (real shapes
  below until the record comes); then *What wisp asked it*, folded like a long prompt, the task's
  own transcript and *What it saw*. Under way it grows live, with no Stop (Stop is the task's).
  Read-only: no reply box, band, Ship or task keys.
- **Band** on top of the open task (sticky on a wide pane), two fixed rows so nothing jumps:
  the mark, *Done when*, the condition (one line), the state, a menu; then a 120px progress track
  (the last check's estimate, last round's as a shadow behind it, the delta beside it), the round,
  and the last check in the checker's words. Paused: **Resume goal** right there.
  Nothing in it pulses; the turn's working panel says it's busy, and during a check the latest
  turn keeps a live *Checking the goal…* panel with Stop.
- **Goal met**, once per goal (remembered in localStorage): the mark draws into a check, the track
  fills green and the band glows once. Reduced motion: none of it. Then *Met in 4 rounds · 23m*.
- **Turns** wisp sent back say *Sent back by wisp: the goal isn’t met yet* and show *Still
  missing* and *Next*; Show all has the whole message the agent read. Folded: *What’s still missing*.
- **Row**: a ring filled to the last check and the round (*4*), the same width in every state; how it ended
  tints it, the tooltip names it. The details column leaves it out (the band has it).
- **Notification**: once, at the end: *… reached its goal in 4 rounds* / *can’t reach its goal* /
  *paused its goal*, with the last check.
- **Spells**: `goal.band` (slot and part), `goal.text`, `goal.track`, `goal.check`, `card.goal`,
  `launcher.goal`, `launcher.goalLine`, `launcher.goalJudges`, `composer.goal`, `composer.goalLine`,
  `goal.judges`, `goal.checks`, `goal.run`, `goal.runHead`, `goal.runVote`, `goal.runPrompt`, the `target` and `judge` icons. A spell's old `goalRounds` loads
  with a warning.
