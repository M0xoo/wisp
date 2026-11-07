# UX: how wisp behaves

wisp is something people glance at between other work: a list of agents, some of which need them.
Every rule below protects one of three things: **the click works at once**, **what you were reading
stays put**, and **what needs you is easy to find**.

## Actions are instant

- Change the page first, then call the server. On a refusal, put it back and show a red toast.
  The pattern is `toggleDone` in `web/js/features/actions.js`: `move()` now, `api()` after,
  `revertSummary()` + `toastError(err)` on failure (it skips the revert when a live update has
  replaced the summary since).
- For one-off calls whose result you don't need to undo, wrap them in `tryApi(() => api(...))`
  (`web/js/ui/toast.js`): it turns a failure into a red toast instead of a thrown error.
- Clear a text box the moment you send it; put the text back if the send fails.
- A dialog opens on the click, in its final shape, with placeholders for what's still loading
  (*Ship it* used to wait a second for git and gh before showing, 0.38.0). Never make a click
  wait on the network before anything visible happens.
- Reversible actions (Mark done, Archive, rollback, revert a file) don't ask first: they act and
  offer **Undo** on the toast. Only ask for things that can't be taken back. A delete that waits
  for its Undo toast to go before it's sent (a swiped row, `deleteWithUndo`) counts as undoable.
- Something that can't run right now says why in a toast (*Still working — stop it first or let it
  finish.*); it doesn't silently do nothing.

## When wisp stops answering

The live stream down for 4 seconds puts *Reconnecting to wisp…* on the open pane's head, or at the top
of home and the list, on every layout and in the app (`features/reconnecting.js`). It's a status, not
a question: no buttons, it never covers a title or a pill, it goes when the stream's `hello` arrives, and
it changes nothing a run does. While it shows, the working panel's motion stops: it can't say a run is
moving. A blip under 4 seconds shows nothing. Don't add a second connection signal; a refused action
still gets its toast.

## Asking and telling

- **Confirm** with `ask()` from `web/js/ui/confirm.js`, never the browser's `confirm()`/`alert()`/
  `prompt()`. It sits by the button that asked (`anchor`), names the action on its button
  (`ok: 'Delete recipe'`, not *OK*), and uses `danger: true` for destructive ones.
- **Toasts** (`toast()`, `toastError()`) are short, past tense for what happened (*Archived*,
  *Marked done*), with at most one action (*Undo*, *Open*). They rise above an open task's reply box
  so they never cover Ship it or Mark done (#269); don't position your own. A message that starts with
  an `icon()` wears it as the glyph (pass `glyph` for a face). Only the newest shows, the rest
  tucked behind; hover (tap on phones) fans the stack and holds every timer. × closes one without
  its action, Clear all the lot; the same text twice shows once and three stack at most.
- Errors show the server's message, which should read as a sentence a person can act on.
- Menus and popovers go through `popover()` (`web/js/ui/popover.js`): outside click and Escape close
  the newest one and put focus back on its anchor (or `back`, the text box it serves, so you keep
  typing). Pickers opened from a box keep that box looking focused while they're open (#16, #178).
- **A warning before Ship it or Merge is a line, never a hold.** One sentence, the button stays. Merge turns red only for what's wrong with the PR (checks, review, a clash), not for something on your side, like comments you haven't sent.

## Loading

- Never show an empty box that fills in piece by piece. Placeholders match the real thing's shapes
  and size (the launcher's `.skel` rows in `launcher.css`), and the real controls replace them all at
  once with a short fade.
- Show what you last saw first, then update: the phone app and cloud computers paint the last
  snapshot from `web/js/features/cache.js` while the server catches up (a thin line under the top
  bar says it's syncing).
- Split view paints from the first frame, not after `app.js` loads (#196). A layout that depends on a
  setting must not flash the other layout first.
- Batch layout reads with `beforePaint()` (`web/js/core/dom.js`) instead of measuring right after
  each DOM write.

## Stable layouts

- **Never re-append a node that's already in place** on a refresh (SSE, refetch, polling): it
  replays its entry animation and resets its scroll. Compare, and only insert, move or remove what
  changed (`renderFeed`, `renderBody`).
- Selecting, opening or hovering a row never moves anything in it. Times and pills sit in fixed
  columns (grid with `auto` columns, `tabular-nums`); a hover-only button appears *beside* the time,
  not on top of it (#188, #209). Buttons don't drop out when a row opens; tags don't shift.
- Text boxes stay where they are: the reply box is docked at the bottom of an open task, the prompt
  box stays at the top (or bottom in the phone app). An open follow-up box stays open when you
  switch tasks or use its pickers (#178, #215).
- Counts in different places agree (project chip counts match Needs you, #209).
- A line that shows up after the page has painted takes a row that's already laid out, it doesn't
  add one: Bring in's offer shares a grid cell with the launcher's recipes (`.l-foot`), which stay
  in the cell, hidden, holding the height. Text in the box gives the row back to them.
- New task's rows each hold one kind of thing: the row over the prompt is places, the bar under it is
  how the task runs, the Recipes row is what to start from (recipes, and **Issue** pinned at its right
  end, shown only with a project picked). An action that fits none of them doesn't go in a row of places.
- Empty states are useful or absent: we removed the "Nothing needs you" line (#197) rather than show
  filler.

## Scroll and focus

The rules are written up in `docs/feed.md`; the code is `web/js/features/scroll.js`.

- Go through `scroll.js` (`scrollByPx`, `keepInPlace`, `feedAnchor`, `atTail`, `topInset`); never
  set `#stage.scrollTop` yourself. A plain `scrollTop` write cancels a smooth scroll in flight.
- You own the scroll: nothing that happens by itself (a run finishing, a turn starting, a queued
  follow-up, a compact, a goal round, a refetch) moves what you're reading. `watching()` only says
  a task is the open one; never ask it whether someone is reading.
- The one exception is the tail. `atTail(box)` (`web/js/tail.js`): within 40px of the end new output
  keeps you there, and once you scroll up you've left it, even by 30px, until you come back down.
  A new scroller that follows its output asks this, like the crew thread and the task's body do.
- Your own send moves the view once, to your prompt. The real turn replacing the pending one isn't
  new (`turnChange`), and a send with no pending turn flags the next one (`ownSend`). What only
  queues moves nothing.
- Nothing is lost by staying put: the *Latest* pill over the reply box says something landed while
  you were away from the tail, and takes you there.
- The list holds still: a background re-render keeps the row under the top of the list in place
  (`keepInPlace(feedAnchor(id), renderFeed)`). A row that changes section never drags the list after
  it, the open task's included: the list moves when you scroll it, press J / K, or open a row that's
  out of view (`showRow`).
- Leaving the list (Mark done, Archive, Delete) from the open task goes to New task, never to
  another task. From a row in the list, focus moves to the next card, which lands where the old
  one sat (`handOff`).
- In split view, clicking a row doesn't scroll the sidebar (#135). Opening one from search or a
  toast scrolls it only when the row is out of view (#190). Clicking a task focuses its reply box
  (#214). A launch from New task leaves the list too: a row that doesn't show gets the *Sent to*
  toast with Open.
- Scrolled-to cards land below the top bar and the docked launcher (`scroll-padding-top`), not under
  them (#5).
- A refresh never takes the keys. A row that changes list or section keeps the focus inside it
  (`focusBack()`), so the next word goes in the box and not to a one-key shortcut. On a touch screen
  Send lets the box go, so the keyboard drops and the run shows.
- Escape closes the newest thing: a popover, then an overlay, then blurs a text box, then closes the
  open task. Keep that order when you add a layer.
- Clicking the logo goes back to the prompt box, focused (#270).

## Split view, side by side and stacked

- Split view is the only layout (the feed is gone). From 900px the list and the open task sit side
  by side; under 900px, and always in the phone app, they stack (`body.stack`): the list fills the
  window, and a task, a crew member's thread or home (New task) opens over it as a page
  (`body.stack-page`) whose head starts with **Back** (icon only, *Back to tasks*, or *Back to
  ‹member›* for a crew job). A change to a row, task bar, composer or details is checked in **both**
  (`split.css` holds the stacked rules at its end).
- Back (the button, Esc, the phone's Back) goes from a crew job to its member, then to the list. The
  list stays laid out under the page (never `display: none`: the open body lives in it), so it's
  where it was scrolled when you come back.
- A page slides in only when you open it (`.stack-in`, for the move only): never on the first paint,
  a refresh or the window narrowing onto it.
- Panes pinned on home tile side by side: as many columns as fit at 300px or more (`columns` on the
  `split.panes` part is the most it shows), in the order of their pins, with grips between and under
  them. A drag wins over a spell's `widths` and `height` until the spell's values change, and it's
  saved in the browser (`wisp.panes`). Stacked they're rows that open as a page with Back (no grips,
  and no frame until tapped). A frame never moves in the DOM: a pane that isn't showing is
  `display: none`, so its app keeps running.
- Split view's home always lists what needs you under **Needs you**, above the tips. Tips show only
  on the side-by-side home: never stacked or in the phone app.

## Same actions, same names

A task's actions are offered in several places: the right-click menu, the open task's bar and its
**More** menu, split view's details column, the ⌘K palette (`commands.js`) and the keys (`keys.js`).

- A new task action goes in **all** of them (directly or under More), with the same label, and in
  `card.menu` for spells. The details column offers every right-click option.
- One name per action across the app: *Rerun* (not *Replay*), *Mark done* / *Reopen*, *Archive*,
  *Ship it*. See [copy.md](copy.md).
- A new shortcut is added to `BUILT_IN` in `keys.js` (so spells can't claim it), shown in the menu
  with `keyHint()`, and listed in the shortcuts sheet (`shortcuts()` in `web/js/ui/kbd.js`). Use
  `modKey()` / `combo()` for ⌘/Ctrl.

## Keyboard and accessibility

- Everything that can be clicked can be reached with Tab and shows a focus ring.
- `j`/`k` move through rows and keep the focused row visible; tall cards align by their top.
- Icon-only buttons have `aria-label` and `title`. Dialogs use `role="dialog"` /
  `role="alertdialog"`.
- `on*` handlers in `web/js` get block bodies: `onclick = () => doThing()` returning `false`
  cancels the click (AGENTS.md).

## Never in the way

- Things that need the person (questions, approvals, waiting pills, the spell review) are never
  hidden, restyled or covered, by spells or by other UI.
- Floating things (toasts, the FAB, popovers) never cover the reply box, Send or the open card's
  buttons. If a floating button would sit on content, drop it on that width (the phone's floating
  *Collapse*, #269).
- The clash card (`/side`) says each thing once, so its answers sit above the reply box on a phone:
  no second box for the main task's lines when the diff already shows them, and no text box of its
  own, the reply box says *Or say what to do instead*.
- **Questions and approvals have one answer box: the reply box.** Their cards hold the question,
  its context and its buttons, never a text box of their own. What's typed in the reply box answers
  the question, or denies the approval with those words, whatever the task's mode and whatever mode,
  harness or team is picked under the box (those wait for the next follow-up). Its placeholder says
  so in words that fit a phone: *Answer Claude Code…*, *Or say what to do instead (denies it)…*. It
  is optimistic like a button: the card goes at once and comes back with a toast if refused. A spell
  that hides `composer` or `composer.input` doesn't hide it while a task waits on an answer.

## wisp Grid's Home and Account

The grid's signed-in pages (`grid/pages.js`), server-rendered, wisp's look.

- **Two pages, one header.** *Home* (`/`) is what you use: the cloud wisp, your computers, your apps,
  what to try. *Account* (`/account`) is what you rarely change: devices, sign-ins, sign out, delete.
  A destructive action never sits on Home beside *Open*; on a card, *Remove* and *Unpublish* are
  quiet until hovered.
- **A tile says one thing and one next step,** and only what exists on this grid (`offers`). It says
  what's already true when the grid knows it (*4 published*), in a slot beside the step, so it never
  changes shape. The grid can't see agent sign-ins or tasks: no tile claims them, no fake stats,
  no checklist it can't tick.
- **One size in every state.** The cloud block keeps its two-row line, Sleep's place (hidden, not
  gone) and a *Next schedule* row, so asleep, waking and running move nothing.
- **What the page refreshes lives in `[data-live]`; what you're using doesn't.** *Add a computer* and
  the picture stay outside those blocks, so a live change never closes or repaints them.
- **Adding is the last card of the list it adds to.** Same grid, same size as its neighbours, 1px
  dashed `--line-2` with a big + (dashed is how wisp says "add", as in `.lp-chip.add` and the crew's
  empty rail); solid on hover and while open. A panel can't fit in a card, so it opens as the next
  row, full width, and the + turns into ×: nothing above it moves. The cards' `[data-live]` block is
  `display: contents`, so a computer that arrives lands in the same grid, before the card. With
  nothing in the list the card takes the whole row; on a phone it's one compact row. Only where
  adding happens on this page: *Published apps* gets no card, publishing happens in wisp.

## Several accounts on wisp Grids

- An account is named by its grid and its handle: the grid's name (its address when two grids share
  a name) on top, the handle under it. Two accounts on one grid differ only by handle, so it's never cut.
- The first sign-in form is open while there's no account; after that it sits behind **Add an
  account** (as Machines does with Add a machine), on the phone and in Settings → Cloud.
- You pick the account in the browser. Adding one says so once (*Use another account* on the grid's
  page), on the sheet or form that starts it, not on every card.
- A computer added to a grid is listed under its account, set in on screens wider than 420px.
