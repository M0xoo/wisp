# The feed: task states, moves and scrolling

How a task moves through the feed in the web UI, and what the page does with your scroll position
and focus: nothing that happens by itself moves what you're reading, only the tail follows. The code
is in `web/js/features/`: `feed.js` (`groups()`, `taskOf()`, `handOff()`), `turns.js` (`renderBody()`),
`scroll.js` (`keepInPlace()`, `feedAnchor()`, `showRow()`, `topTurn()`) and `live.js` (the `summary` event handler),
and `web/js/tail.js` (`atTail()`, `turnChange()`).

## Sections

| Section | Holds | Order |
|---|---|---|
| **Needs you** | `waiting` (asking) and `review` (finished) | asking first, then most recently updated |
| **Working** | `running` | launch order, newest first (stable while it runs) |
| **Done** | `done` (collapsed section by default) | most recently updated |
| **Archived** | `archived: true`, any state (hidden by default) | most recently updated |

## States and what moves a task

```
             launch (box, rerun, CLI, MCP, SDK)
                          │
                          ▼
   ┌──────────────── running ───────────────┐      Working
   │  agent asks        │ finishes / Stop   │
   ▼                    ▼                   │
waiting ──answer──▶ running            review ◀── Reopen / Undo ── done      Needs you / Done
                                        │  │                        ▲
                         follow-up ─────┘  └──── Mark done (E) ─────┘
                       (back to running)

 review | done ──Archive (A)──▶ archived ──Unarchive──▶ back to its section
 any ──Delete──▶ gone (a running task is stopped first)
```

| From | Action | To | Who triggers it |
|---|---|---|---|
| — | Launch from the box, Rerun…, CLI / MCP / SDK | `running` → Working | you / another tool |
| `running` | Agent asks a question | `waiting` → Needs you (top) | agent |
| `waiting` | Answer (composer or options) | `running` → Working | you |
| `running` | Agent finishes | `review` → Needs you (top) | agent |
| `running` | Stop | `review` → Needs you | you |
| `running` | Follow-up while it runs | stays `running`, queued (or interrupts if not queueing) | you |
| `review` / `done` | Follow-up | `running` → Working | you |
| `review` | Mark done (E, ✓ on the row, *Mark done* by the composer) | `done` → Done | you |
| `done` | Reopen, or Undo on the toast | `review` → Needs you | you |
| `review` / `done` | Archive (A) | archived → Archived | you |
| archived | Unarchive | back to its section | you |
| any | Delete (stops it first if running) | removed | you |

## Compare tasks

A launch with **vs** (or `compare` in the API) starts one session per harness, all sharing a
`groupId`. While two or more of them are on the same side of archived, the feed shows them as
**one task card** (`taskOf()`, `taskItem()`): the prompt as the title, a status line, a **Compare**
button for the side-by-side view, and a row per run. Each row is an ordinary item (harness and
model instead of a title) that expands in place, takes follow-ups and answers, and is reached by
j / k like any card.

The task's state, which decides its section, comes from its runs:

| Runs | Task state | Section | Status line |
|---|---|---|---|
| any `waiting` | `waiting` | Needs you (top) | A run is asking you |
| else any `running` | `running` | Working | *n* of *m* finished |
| else all `done` | `done` | Done | Done |
| else (finished, some not done) | `review` | Needs you | All finished · pick one to keep |

| Action | Result |
|---|---|
| **Keep this** in Compare | the other runs are stopped, archived and lose their worktrees; the kept run is an ordinary card again |
| ✓ on the task row | every finished run → `done`, one toast to undo them all |
| Mark done / Archive on one run | that run moves; the task stays a task while two or more runs remain together |

Compare runs keep the prompt as their title: one run's headline shouldn't name the task.

## Scroll and focus rules

Five rules decide what scrolls. *Watching* is no longer a question they can ask: in split view
`watching()` only means the task is the open one, so they go by where the reader is (`atTail()`).

1. **You own the scroll.** Only your own action moves a scroller. Nothing that happens by itself (a
   run finishing, a turn starting, a queued follow-up, a compact, a goal round, a refetch, an event
   from another task) moves what you're reading. A render holds the turn at the top of the view
   (`topTurn`, `renderBody`), and the answer you may be reading stays open when a new turn starts.
2. **One exception, the tail.** At the end of the running task (`atTail()`: within 40px), new output
   keeps you at the end and its result lands where you can see it. As soon as you scroll up you've
   left the tail, even 30px (the slack is then 2px), and nothing moves, with the working panel on
   screen or not, until you come back to within 40px of the end. The crew thread works the same way.
3. **Your own action moves the view once.** Sending a follow-up brings your prompt to the top, one
   time: the real turn taking over from the pending one isn't a new turn, and a follow-up that
   interrupts the run or a queued one you Send now does the same when its turn comes. A follow-up
   that merely queues moves nothing: it starts by itself later. Opening a task from a search or a
   toast brings its row into view: opening a card, *Open* on a toast or notification, ⌘K, and
   j / k scroll the card's header under the top bar.
4. **The sidebar holds still.** A follow-up or answer takes the open task's row to Working, finishing
   or Stop brings it back to Needs you, Reopen and Unarchive bring it back too: the list stays where
   it was, even if the row leaves the screen, and the main pane still shows the task. The list only
   moves when you scroll it, press J / K, or open a row that's out of view (`showRow`). When the feed
   re-renders because something changed elsewhere, the first row showing is held in place
   (`feedAnchor` + `keepInPlace`). At the very top of the list nothing is held, so new rows push it
   down.
5. **Nothing is lost by staying put.** When something lands while you're away from the tail, a small
   *Latest* pill over the reply box takes you there. It goes when you click it, reach the tail, or
   the latest turn's head comes on screen.

The rest:

6. **Cards you weren't watching fold when they finish.** A card left open while it ran collapses
   when it lands in Needs you, unless you're watching it in a focused window.
7. **Taking a card out hands off to the next one.** Mark done, Archive and Delete focus the card
   below (or above, at the end of the list) and put it exactly where the old one sat
   (`handOff`), so E / A / j keep working from the same spot.
8. **Collapse all (C) and Esc keep your place.** Collapse all centres the card you were reading;
   Esc folds the focused card and keeps its header on screen.
9. **A new project filter starts at the top of the feed.**
10. **A task you launch from the box is confirmed, not chased.** Its row lands in Working, usually
    below everything in Needs you. If it shows, the wisp flies from the launcher to it. If it doesn't,
    the list stays where it was and a *Sent to Claude* toast offers **Open**. Stacked, the list is what
    you see, so the row scrolls into view and flashes (on the phone, to the middle, with the toast).

"Under the top bar" means below the stage's `scroll-padding-top` (top bar + docked launcher),
read at runtime by `topInset()`.
