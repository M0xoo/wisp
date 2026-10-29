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

`session.goal = { text, round, status, from, setAt, endedAt?, why?, checks[], fresh? }`,
each check `{ turnId, round, verdict, why, next?, progress?, tests?, changed, at }`.

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
- **Not for** subagents, delegates, crew jobs, spells, the tour.

## UX

- **Launcher**: *Goal* in the bar (icon only on a phone) opens a *Done when* line under the prompt.
  On/off and the text
  survive a reload; an empty line launches without a goal and says so in a toast.
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
  `launcher.goal`, `launcher.goalLine`, the `target` icon. A spell's old `goalRounds` loads
  with a warning.
