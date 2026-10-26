# For later: tasks you parked to look at again

A bookmark with no time on it. *Needs you* is what wants you now. **For later** is what can wait
until you have a minute: a long report, a PR to read properly, a crew member's digest. It is not
*Scheduled* (later.md), which is work wisp does *at a time*. Nothing in For later runs or pings you.
Sana reviewed the backend and Gucci the UI before it was built; the decisions they changed are
marked *(review)*.

Code: `server/routes/sessions.js` (PATCH `forLater`), `server/runner.js` (cleared when a turn
starts, filed from a crew block), `server/crew.js` (`forLater` in the crew block), `server/later.js`
and `server/services/ship.js` (news takes a task out), `web/js/core/state.js` (`isForLater`,
`needsYou`), `web/js/features/feed.js` (the section, the row button), `web/js/features/actions.js`
(`setForLater`, the menus), `web/js/features/crew.js` (jobs and the thread). Tests:
`test/for-later.test.js`, plus some in `test/crew.test.js` and `test/spells.test.js`.

## The model

`session.forLater = { at, by }` records when it was saved and by whom: `user`, or `crew` for a
member that filed its own report. The summary carries it. Nothing else changes: the task keeps its
state, its verdict and `unread`, so a crew report filed there unopened stays bold there *(review)*.

| What happens | Result |
|---|---|
| **Save for later** (`L`) on a finished task (review or done, not archived) | It moves to *For later*, newest saved first |
| A crew check-in (or watch) ends with `"forLater": true` in its crew block | Same, with `by: 'crew'`. Nobody is notified |
| **Unsave** (`L` again) | It goes back where its state puts it (*Needs you* or *Done*) |
| **Mark done**, **Reopen**, **Archive** | It leaves For later for that section |
| A new turn starts (your follow-up, a scheduled follow-up, a crew follow-up, Auto) | It leaves For later, and lands in *Needs you* when the turn ends |
| A reminder or missed follow-up comes due, or there's news on its PR (CI, review, merged, a failed conflict fix) | It leaves For later *(review)* |

Rules:

- **It never hides what needs you.** A task that is running, asking or has a live run can't be
  saved: the action isn't offered, and the server returns 409 *Still working — save it for later
  once it's finished.* New work takes a task out. The page treats a task with a due reminder as not
  saved. This is the same rule as Scheduled.
- **It isn't counted as needing you.** `needsYou(s)` (state.js) is the one predicate for the tab
  title, home's *Needs you*, a crew member's dot and its *Reported:* line. Opening a saved task
  marks it read as usual.
- **Undo is safe.** PATCH applies `forLater` after `state` and `archived`, and accepts a past time,
  so Undo after Mark done sends `{ state: 'review', forLater: <its old time> }` and the row goes
  back to its old place *(review)*.
- **For later wins over Scheduled.** A saved task with a follow-up to come stays in For later and
  keeps its clock pill.
- **Machines.** A wisp on another machine from before this feature ignores the field. The page
  checks the reply and, if `forLater` is missing, rolls back with *Update wisp on … to save its
  tasks for later* *(review)*.

## The crew

Crew jobs normally live under their member and never in the task sections. For later is the one
section they join, because it's the user's own list:

- **Save for later** on a job moves its card from under the member into For later, with the
  member's face where the project dot goes. You can do this from the job's card, from the job open in
  the main pane, or from the member's thread, beside *Open job* and *Follow up*. The member's row
  stops saying *Reported: …* for it. In the thread, the button turns into a pressed **Saved for
  later**; click it to unsave. There is no separate tag, so the words appear once *(review)*.
- **Back** from a job opened from For later goes to the list, not the member's thread *(review)*.
  On desktop the crumb still names the member (*Open Ada*).
- **A member can file its own report there.** Check-ins and watch jobs, on their first turn (the
  jobs that may be `quiet`), may set `"forLater": true`, meaning *worth reading, not urgent* (a
  digest, an FYI). It sits between `quiet` (logged and archived) and a normal report (notified,
  *Reported:*). If both are set, `forLater` wins, since there is something to read *(review)*. The
  job lands in For later, unread, with no notification, toast or dot. The heading counts those as
  *· 1 new*, so they don't go unseen *(review)*. The member's log line says *(filed for later)*. When
  someone waits on the answer (you asked, an `@mention`, a delegation), `forLater` is ignored.

## Where you see it

- **The section** sits in the task list between *Scheduled* and *Done*. Its heading shows *For
  later* and its count, plus *· N new* for unread reports a crew member filed. It folds and
  remembers like the others, is hidden when empty, and pages 60 rows at a time like Done. Rows are
  ordinary cards. The time column shows when the task was saved; its tooltip reads *Saved for later
  2h ago · last activity 5h ago*, or *Filed for later by Ada…*.
- **The row button.** With a fine pointer, hovering a row in *Needs you* shows the bookmark to the
  left of *Mark done*, which stays rightmost, so triage is one click either way. Hover shows the
  accent colour. In For later the bookmark is filled and means *Unsave*. Every row keeps the slot,
  so nothing shifts. On touch it isn't drawn at all and takes no space: *Mark done* is always shown
  there, and the long-press menu and More have the action *(review)*.
- **Same name everywhere**: **Save for later** / **Unsave** in the right-click menu, the task's
  More menu, ⌘K, the key `L` (listed in the shortcuts sheet) and the crew thread *(review: not
  "Remove from For later")*.
- **Toasts**: *Saved for later* and *Unsaved*, each with **Undo**. The change is optimistic: the row
  moves at once, the next task takes its place as with Mark done, and it goes back with an error toast
  if the server refuses.
- **Not on split home** *(review)*: the sidebar section sits right beside it, and showing the same
  list twice on one screen breaks the rule against duplicated text.

## Spells

The parts `section.forLater` (the section) and `card.quickLater` (the row's button), the
`forLater` action (`{ "forLater": true }`) for buttons, commands and hooks (for example, save every
task whose tests passed), and the icon `bookmark`.

## Not yet

- A note on why you saved it.
- Saving a task that's still working, so it lands in For later when it finishes.
- `wisp_save_for_later` on the outside MCP. `wisp_sessions` already says *(for later)*.
- A tip for it (the copy comes from marketing).
