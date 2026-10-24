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
  offer **Undo** on the toast. Only ask for things that can't be taken back.
- Something that can't run right now says why in a toast (*Still working — stop it first or let it
  finish.*); it doesn't silently do nothing.

## Asking and telling

- **Confirm** with `ask()` from `web/js/ui/confirm.js`, never the browser's `confirm()`/`alert()`/
  `prompt()`. It sits by the button that asked (`anchor`), names the action on its button
  (`ok: 'Delete recipe'`, not *OK*), and uses `danger: true` for destructive ones.
- **Toasts** (`toast()`, `toastError()`) are short, past tense for what happened (*Archived*,
  *Marked done*), with at most one action (*Undo*, *Open*). They rise above an open task's reply box
  so they never cover Ship it or Mark done (#269); don't position your own.
- Errors show the server's message, which should read as a sentence a person can act on.
- Menus and popovers go through `popover()` (`web/js/ui/popover.js`): outside click and Escape close
  the newest one and put focus back on its anchor (or `back`, the text box it serves, so you keep
  typing). Pickers opened from a box keep that box looking focused while they're open (#16, #178).

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
- Empty states are useful or absent: we removed the "Nothing needs you" line (#197) rather than show
  filler.

## Scroll and focus

The rules are written up in `docs/feed.md`; the code is `web/js/features/scroll.js`.

- Go through `scroll.js` (`scrollByPx`, `keepInPlace`, `feedAnchor`, `watching`, `topInset`); never
  set `#stage.scrollTop` yourself. A plain `scrollTop` write cancels a smooth scroll in flight.
- A background re-render holds the card under the top bar in place (`keepInPlace(feedAnchor(id),
  renderFeed)`). A card you're watching that moves section is followed; one that only peeks in at
  the edge is not.
- Leaving the list (Mark done, Archive, Delete) hands focus to the next card, which lands where the
  old one sat (`handOff`).
- In split view, opening a task doesn't scroll the sidebar (#135), and only scrolls it when the
  row is out of view (#190). Clicking a task focuses its reply box (#214).
- Scrolled-to cards land below the top bar and the docked launcher (`scroll-padding-top`), not under
  them (#5).
- Escape closes the newest thing: a popover, then an overlay, then blurs a text box, then closes the
  open task. Keep that order when you add a layer.
- Clicking the logo goes back to the prompt box, focused (#270).

## Split view and the feed

- Both layouts render the same card nodes. A change to a row, card, task bar, composer or details
  must be made and checked in **both** (`body.split` rules live in `split.css`, the feed's in
  `feed.css`).
- Split view's home always lists what needs you under **Needs you**, above the tips. Tips show only
  on split home: never in the feed or the phone app.
- Windows under 900px always get the feed; the phone app always gets the feed.

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
