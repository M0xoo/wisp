# Ask near the limit

Plan budget (design/budget.md) shows how full each account's 5-hour and weekly windows are, and a
limit card asks what next once a run hits one. That's after the fact: by then a task stopped
halfway, or a night of scheduled runs burned the week. Ask near the limit acts before: a task or a
follow-up that would likely take its account's window past a line you set waits for a yes, or for
the reset.

Planned with Sana (architecture) and Gucci (UI); the owner's weekly window was at 91% that day.

## The rule

`web/js/limit-hold.js`, DOM-free and shared, so the page can decide before it sends and the server
checks the same thing.

- **Line**: Settings → Usage → *Ask near the limit*, `defaults.limitHold`: `off | 80 | 90 | 95`,
  default `90` (spell-lockable).
- **Hold** when `used + p75 estimate ≥ line` for any window of the account (`holdFor`). With no
  estimate yet, that's `used ≥ line`. The window nearest its limit is the one named.
- **After a yes** the window asks again only at the next step (95%, then 99%), or after it resets
  (`nextLine`; `Budget.ack` keeps `{ resetsAt, line }` per window). Without that, someone at 91% on
  Monday would be asked on every send until Thursday.
- **Numbers**: a range when it's wider than 2 points (*88–96%*), else *about 93%*, rounded down;
  never *100%+*: *past the limit* (`holdTo`).

## The estimate (server/guard.js)

Two halves, both from what wisp already records; nothing is asked of the provider.

1. **Units of work** a run like this takes: Claude's `total_cost_usd` (on a plan too), else tokens
   (`input − cached + output`, in millions). p50 / p75 / p90 of the last 50 finished runs of the
   harness in 30 days: first turns for a new task, follow-ups for a follow-up. A schedule, trigger,
   recipe or crew job with five runs of its own uses those. A follow-up is at least this task's own
   median. Subagents don't count as samples.
2. **Share of the window per unit**, learned in `Budget` (`server/budget.js`): Claude reports the
   windows after every request, so readings come while runs work. What a window moved between two
   readings under 30 minutes apart counts (`learn.du`), against the units of the runs that ended
   (`learn.units`, `Budget.spend`). Two points must have moved first (the CLI reports whole
   percents); past 30 points both halve, so it follows recent runs. It's capped by the window's whole
   use over wisp's units in it, so heavy use outside wisp can't make it absurd. Before it has
   learned, there's no estimate: only a window already past the line holds.

Runs going on the same account add half their own estimate, so automations that fire together
don't all slip under the line.

Real numbers, 2026-10-27 (owner, Claude Max): the 5-hour window moves ~0.8% per dollar, the weekly
one ~0.02%. A typical first turn is $0.60, a big follow-up $15: the 5-hour window is where the
estimate matters; the weekly one is mostly "already past the line".

## Where it's checked

| Path | What happens |
|---|---|
| New task from you (`launch()`, page, CLI, API) | 409 `{ error, hold }` until `confirmLimit: true` |
| Follow-up from you (`replyTo`) | same; an answer to the agent's question isn't checked |
| Schedule, trigger, recipe, Later plan, crew job (`launch()` with an origin or crew) | the task is made with a **held turn** |
| Scheduled follow-up (`later.fire`), goal round, trigger or crew follow-up | the follow-up becomes a held turn on its task |
| Machine | each machine checks its own budget; the 409's `hold` comes back through `machines.js` |
| Not checked | subagents, `/btw`, a crew job a lead delegated, a moved task, the queue draining a follow-up already checked |

A held turn (`status: 'held'`, `turn.held`, `turn.run` with what it carried) keeps the task in Needs
you (`state: review`, unread). It goes by itself at the window's reset (`Later.tick`); still over a
line then (the weekly after the 5-hour reset), it waits for that reset. `POST /sessions/:id/held`
`{ action: start | wait | skip }`: start counts as your yes; wait takes it out of Needs you into
Scheduled; skip leaves it stopped with a *Skipped before it started* hero. A follow-up you send on a
task with a held turn sends the held one first and queues yours behind it.

wisp never switches accounts or harnesses because of the line (design/accounts.md → Terms).

**With Automations stop at** (design/budget.md, `defaults.autoStop`, off by default): that one runs
first on its own paths (crew ticks, triggers, goal rounds, agents' follow-ups) and silently moves
unattended work past a fixed share to the reset. Ask near the limit then covers what's left,
including your own sends, with an estimate, and keeps what it holds in Needs you.

## Page

- **Hold row** over the reply box (`.c-hold`, above the textarea, so Send doesn't move) and under the
  prompt box's bar (`.l-hold`, where the recipes and the time chip go). *Claude Code’s 5-hour
  window is at 84%. A follow-up like this usually takes it to 88–96%.* Buttons: **Send anyway** /
  **Start anyway**, **Wait until Thu 21:00** (Later: a scheduled follow-up or a Start later task),
  × **Keep editing**. The draft stays in the box. Enter = anyway (not a repeat, not within 300 ms),
  Alt+Enter = wait, Esc = keep editing. A 409 from the server shows the same row.
- **Held card** under the held prompt (`.b-held`, like the limit card): *Held before it started:
  this run may take Claude Code’s weekly window from 91% to about 96%. Left alone, it waits for the
  reset.* **Start now** / **Send now**, **Wait until …**, **Skip this run**. Optimistic, rolled back
  with a toast.
- **Row**: a *Held* pill (`i-pause`), the sub line says the window (*Weekly window at 91%*), or in
  Scheduled *Waiting for the weekly reset*, with the reset in the time column.
- **Harness picker**: a harness at or past its line says so instead of its model count (*Weekly
  window at 91%*); an account segment shows its percent.
- **Settings → Usage**: *Ask near the limit* `Off · 80% · 90% · 95%` under Plan budget; the bars turn
  `--warn` at that line.

Spells: `settings.limitHold`, the `harness.usage` part. The hold row and the held card aren't parts:
they need you, like a due reminder.

## Not yet

- Auto (`agent: auto`) is checked on the harness it picked; it doesn't yet prefer one under the line.
- The `wisp` MCP server's launch tool can't pass `confirmLimit`: an agent gets the 409 and should ask.
- The row doesn't go away by itself when the window drops back under the line; × does.
