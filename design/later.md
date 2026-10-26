# Later: work at a time you (or an agent) set

Scheduled follow-ups into the **same task**, scheduled tasks and reminders, and where you see what's
coming. Code: `server/later.js`, `web/js/when.js` (reads a time out of a prompt),
`web/js/features/later.js`; tests in `test/later.test.js`. Reviewed before it was built by Sana (the
backend) and Gucci (the UI); the decisions they changed are marked *(review)*.

## The three things

| You (or the agent) say | It becomes | Kept in | When it's due |
|---|---|---|---|
| *in 10 min check again* in a task's reply box, **Send later**, or the agent's `resume_later` | a **scheduled follow-up** | `session.later[]` | sent into that task's own conversation, as if typed then |
| *in 5 min run the e2e suite* in the prompt box, or **Start later** | a **scheduled task** | `config.later[]` (a plan: the launch body) | launched with the harness, mode and project picked when you typed it |
| *remind me to review the PR in 1 hour* | a **reminder** (no agent) | a plan, or `session.later[]` with `remind` in a reply box | in *Needs you* with a bell; notifies; **Snooze…** or **Mark done** |

```
 prompt / reply box ──when.js──▶ chip "Starts at 14:35" ──Enter──▶ POST /later  or  POST /sessions/:id/later
 agent ──resume_later (MCP)──▶ POST /internal/later ───────────────────────────────▶ session.later
                                                                                       │
                       Later.tick() every 20 s (and once at boot) ◀────────────────────┘
                         │ plan due           → launchAny(body)          (a day late: a "Missed" reminder)
                         │ follow-up due      → runner.reply(s, text, { by: 'later' })  same conversation
                         │   held while it runs, asks, waits on delegates or Auto checks   (a day late: Needs you)
                         │ reminder due       → s.reminder, state review + unread, notify
                         └ nextAt()           → GET /api/status nextWakeAt (Grid wakes a sleeping wisp)
```

## Rules

- **Same conversation.** A follow-up goes through `runner.reply` with `by: 'later'`. It doesn't cancel
  Auto's repair round *(review)* and isn't read as `/btw` *(review)*. The turn records
  `turn.later = { by, setAt, at, late? }`. The agent reads a note first (*this is the follow-up you
  scheduled at 14:12…*; when late: *check the current state*). The bubble shows only the message
  *(review)*.
- **Held, never dropped.** A due follow-up stays in `session.later` until the task is free. It is
  not pushed onto `runner.queue`, which a Stop or a restart empties *(review)*.
- **Limits.** From 1 minute to a month (an agent: a week). At most 5 per task. An agent gets 10 in
  a row (`laterChain`, reset by your message) before `resume_later` tells it to report back.
  Subagents can't schedule. `at` from an agent must carry its offset *(review)*.
- **Mark done** drops the agent's own follow-ups and keeps yours *(review)*. **Archived**: what's due
  lapses. **Deleted**: it goes with the task.
- **Late.** Fired up to a day late, it says how late. Later than that: a plan becomes a *Missed*
  reminder, and a follow-up waits in *Needs you* as a reminder. Never more than 3 a tick.
- **Grid.** `nextAt()` only counts what can run, never a time in the past *(review)*. A past
  `nextWakeAt` would keep a box from ever stopping.
- **Machines.** A task on a machine keeps its follow-ups there; its summary carries them back and the
  page reaches them through the session proxy. Plans run here (their body may name a machine).
- **Crew.** A job's `resume_later` continues **that job**; `wakeIn` still starts a fresh check-in.
  The crew prompt says which is which. Both show in *Coming up*.
- **Reading times** (`when.js`): one phrase at the **start** of the prompt (*in 5 min*, *in an hour*,
  *at 4pm*, *tomorrow (at 9)*, *tonight*, *on Monday (at 9)* / *Monday at 9*). A phrase at the end
  counts only after *remind me* *(review)*. *make the cron run at 2pm* is just a prompt. Nothing
  is scheduled unless the chip showed it. Settings → *Read times in prompts* (`readTimes`) turns it off.

## Where you see it

- **Prompt box / reply box:** after a 250 ms pause the chip takes the recipes row (prompt box) or the
  hint row (reply box), so nothing moves *(review)*. It reads *Starts at 14:35* / *Sends at 14:45* /
  *Reminds you at 15:30*, with **Start now** / **Send now** (not on reminders) and × (*Not a time*).
  The clock beside Send lights up, Send keeps its icon, and Alt+Enter ignores the time. The clock button beside Send (**Send later** / **Start
  later**) opens the time menu: *In 10 min · In 30 min · In 1 hour · In 3 hours · Tomorrow morning ·
  Pick a time…*, each with the time it means. The clock works before you type: a choice *sets* the
  time (the same chip, × is *Clear the time*, the clock says *Change start time*) and Enter schedules
  once there's text. A set time beats one read from the text. Gone by when you press Enter: the chip
  says *16:10 has passed* and the menu opens again; the draft stays. *Pick a time…* turns into a
  field in its own row (the menu keeps its size and place), its time in the time column, Enter takes
  it, Escape goes back to the row. Attached files go with a scheduled task or follow-up.
- **Above the reply box:** each follow-up is a row like a queued one (*At 14:45 · set by the agent ·
  message*, ×). A click or right-click gives **Send now / Change time… / Cancel follow-up**. × acts at
  once with **Undo**, no confirm *(review)*.
- **The card:** a clock pill with the next time (*14:32*, *+1* for more) in *Needs you*, under a crew
  member, and in the details. On phones it shrinks to the clock. The list never says *in 18m*: times
  ahead are absolute *(review)*.
- **The *Scheduled* section** (sidebar and feed, between *Working* and *Done*) *(review: not "Coming
  up")*. It holds plans (clock or bell rows: **Start now / Change start time… / Delete**) and done
  tasks with follow-ups to come, soonest first, with the time in the time column and no pill. A
  task waiting for review or asking you stays in *Needs you*: scheduling never hides what needs you
  *(review)*.
- **Split home, *Coming up*:** under *Needs you*, above the tips, the next 5 (spell prop `count`).
  It lists plans, follow-ups (here and on machines), crew check-ins with their face, and schedule
  triggers with a bolt. A click opens the task, member or trigger, or the plan's menu.
- **Due reminders:** in *Needs you* with a bell and *Reminder* where *Finished* goes. They have a
  notification and a toast, and no reply box (nothing to talk to). **Snooze…** puts them back.
- **Same actions everywhere:** right-click, More, ⌘K: *Send follow-up now*, *Change follow-up
  time…*, *Cancel follow-up* (named by time when there are several), and *Snooze…*.

## Spells
`section.scheduled`, `scheduled.row`, `split.upcoming` (part, slot, prop `count`), `card.later`,
`composer.later`, `composer.sendLater`, `composer.when`, `launcher.later`, `launcher.when`, and the
setting `readTimes`. A due reminder's pill isn't a part: it needs you.

## Not yet
- Repeating follow-ups on a task (a schedule trigger covers it).
- Files on a scheduled follow-up or task (refused with a toast).
- `wisp later` on the CLI, and `in` on the outside MCP's `wisp_reply`.
