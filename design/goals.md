# Goals

A goal is a condition a task has to reach before wisp lets it go: "all tests pass and /login
works on a phone". The agent works, wisp checks the goal, and while it isn't met wisp sends the
task back with what's still missing. The task lands in Needs you only once the goal is **met**,
**can't be met**, it ran out of rounds, or it stalled. Like Claude Code's goals, but for every
harness, and visible the whole time. Code: `server/goal.js`, `web/js/features/goal.js`,
`web/css/goal.css`.

## Words

- **Goal**: the condition. The UI says *Done when* where it shows or asks for one.
- **Round**: one run of the agent toward the goal. *Round 3 of 10*, shown in the band only.
- **Check**: wisp looking at the work after a round.
- States: *Working* · *Checking* · *Goal met* · *Can’t be done* · *Out of rounds* · *Paused* ·
  *Moved on* (Auto handed the task to another run, which carries the goal).
- Actions, the same name everywhere (band menu, More, right-click, ⌘K): **Set goal…** /
  **Edit goal…**, **Pause goal**, **Resume goal**, **Drop goal**. Typed: `/goal <condition>`,
  `/goal` alone (opens the popover), `/goal drop`.

## Backend

`session.goal = { text, max, budget, round, status, from, setAt, endedAt?, why?, checks[] }`,
each check `{ turnId, round, verdict, why, next?, progress?, tests?, changed, at }`.

- **Set**: `goal: { text, max }` on `POST /sessions` (a prompt that is just `/goal …` too), `/goal`
  in a follow-up, or `PUT /sessions/:id/goal`. On an idle task it's checked at once (it may already
  hold). `PATCH { action: pause | resume }`, `DELETE`. `max` is 1–20, default `goalRounds`.
- **Hold**: `Runner#finishTurn` keeps the task in Working when Auto's pipeline wants it or, if not,
  the goal does. After Auto's steps, `runner.settle()` asks the goal before the task lands.
- **Check**: the project's tests first (Auto's run of that turn counts), then a cheap model
  (`quick.js`, read-only, in the task's folder) gets the goal, the task, the diff since the goal
  started (`from`), the test result, earlier checks and, last and labelled a claim, the agent's
  report. It answers `{ verdict, why, evidence[], next, progress }`. A `met` with failing tests or
  no evidence becomes `not_yet`. No model → paused, *couldn't check*.
- **Continue**: `not_yet` under `max` → a follow-up from wisp (`by: 'wisp'`, `turn.goal` = the
  round) with what's missing and what's next. Two rounds in a row that change nothing or get the
  same next step → paused, *stalled*.
- **Moves**: your Stop → paused (a Stop during a check lands the task at once); your follow-up
  keeps the goal and drops a check in flight; an interrupt is not a Stop; a restart pauses it;
  Auto's hand-over gives the goal, with its rounds left, to the new run (`handed` here).
- **Not for** subagents, delegates, crew jobs, spells, the tour.

## UX

- **Launcher**: *Goal* in the bar (icon only on a phone) opens a *Done when* line under the prompt
  with the rounds as chips (3 · 5 · 10 · 20, the `goalRounds` setting). On/off and the text
  survive a reload; an empty line launches without a goal and says so in a toast.
- **Band** on top of the open task (sticky on a wide pane), two fixed rows so nothing jumps:
  the mark, *Done when*, the condition (one line), the state, a menu; then a 120px progress track
  (the last check's estimate, last round's as a shadow behind it, the delta beside it), the round,
  and the last check in the checker's words. Paused or out of rounds: **Resume goal** right there.
  Nothing in it pulses; the turn's working panel says it's busy, and during a check the latest
  turn keeps a live *Checking the goal…* panel with Stop.
- **Goal met**, once per goal (remembered in localStorage): the mark draws into a check, the track
  fills green and the band glows once. Reduced motion: none of it. Then *Met in 4 rounds · 23m*.
- **Turns** wisp sent back say *Sent back by wisp: the goal isn’t met yet* and show *Still
  missing* and *Next*; Show all has the whole message the agent read. Folded: *What’s still missing*.
- **Row**: a ring filled to the last check and *4/10*, the same width in every state; how it ended
  tints it, the tooltip names it. The details column leaves it out (the band has it).
- **Notification**: once, at the end: *… reached its goal in 4 rounds* / *can’t reach its goal* /
  *stopped: 10 rounds and the goal isn’t met* / *paused its goal*, with the last check.
- **Spells**: `goal.band` (slot and part), `goal.text`, `goal.track`, `goal.check`, `card.goal`,
  `launcher.goal`, `launcher.goalLine`, the `goalRounds` setting, the `target` icon.
