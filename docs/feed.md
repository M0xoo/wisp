# The feed: task states, moves and scrolling

How a task moves through the feed in the web UI, and what the page does with your scroll position
and focus when it moves. The code is in `web/js/app.js` (`groups()`, the `summary` event handler,
`watching()`, `keepInPlace()`, `feedAnchor()`, `handOff()`).

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

## Scroll and focus rules

1. **What you're reading never moves on its own.** When the feed re-renders because something
   changed elsewhere (a task finishes, asks, starts, is deleted from the CLI, the stream
   reconnects), the first card under the top bar and docked launcher is held in place (`feedAnchor` + `keepInPlace`).
   At the very top of the page nothing is held, so new cards push the list down.
2. **A card you're watching is followed.** If the card that changes section is the one you're
   reading (`watching()`: it crosses the middle of the screen, or it's focused and at least a third
   of it shows), the view moves with it: a follow-up or answer takes it to Working, finishing or
   Stop brings it back to Needs you, Reopen and Unarchive bring it back too. A card whose edge
   just peeks in at the top or bottom of the screen is not "watched".
3. **Cards you weren't watching fold when they finish.** A card left open while it ran collapses
   when it lands in Needs you, unless you're watching it in a focused window.
4. **Taking a card out hands off to the next one.** Mark done, Archive and Delete focus the card
   below (or above, at the end of the list) and put it exactly where the old one sat
   (`handOff`), so E / A / j keep working from the same spot.
5. **Navigation brings the header into view.** Opening a card, *Open* on a toast or notification,
   ⌘K, and j / k scroll the card's header under the top bar. A card taller than the screen is
   aligned by its top so its header shows.
6. **New output scrolls in only while you watch.** When a turn starts or finishes in a card you're
   watching, the new turn scrolls to the top; otherwise nothing moves.
7. **Collapse all (C) and Esc keep your place.** Collapse all centres the card you were reading;
   Esc folds the focused card and keeps its header on screen.
8. **A new project filter starts at the top of the feed.**

"Under the top bar" means below the stage's `scroll-padding-top` (top bar + docked launcher),
read at runtime by `topInset()`.
