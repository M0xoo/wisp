# Phones

wisp runs on a phone in two ways, and they're not the same:

| | Narrow browser (≤ 720px) | Android app (`mobile/`) |
|---|---|---|
| How to tell | CSS `@media (max-width: 720px)`, `(hover: none) and (pointer: coarse)` | JS `MOBILE` (`web/js/core/state.js`, the `wispMobile` user agent), CSS `body.wisp-mobile` |
| Layout | split view, stacked: the list, a task as a page with Back | the same, always (even on a tablet) |
| What it connects to | the wisp it's served from | *Computers* (desktop's *Machines* isn't shown) |
| First paint | the server | the service worker's cache (`web/sw.js`) and the last snapshot (`cache.js`) |

A fix for phones usually belongs in **both**: the app's rules under `body.wisp-mobile` and the
narrow browser's under the media query (the reply box's mode button is icon-only in both, #221,
#269). Desktop and wide windows must not change.

## Fit the width

- Check at 390px (and 360px for tight rows). Nothing may stick out of its box: Send stays inside the
  prompt box, badges stay whole, long URLs wrap.
- Labels fold to their icons before anything gets squeezed to a sliver (place, harness, mode,
  *Ship it* in the reply bar, #223). Keep the label in `title`/`aria-label`.
- When a row runs out of room, what's least important shortens first (a computer name before *All*;
  a branch name before the recipe chip), and a badge moves to the next line rather than breaking.
- Titles get two lines instead of `do a full audi…`.
- A bar with more buttons than fit scrolls sideways with Send pinned at the end (`.c-bar` in the
  app).
- A status line stays one line at any width and text size: what doesn't fit drops whole, least
  important first (the working panel's action count, then its time), and the name ends in `…`
  (`.w-status`: wrap onto a second line the box clips). A placeholder stays one line and fades out
  at the edge instead of doubling an empty box that shrinks on the first key.

## Touch

- In the app, touch targets are at least 44px (an invisible `::before` can grow a 32px pill's hit
  area). Buttons get a press state (`scale(0.96)`), rows an active background. In the app it shows as
  the finger goes down (`.pressed`, `web/js/ui/press.js`), not when it lifts as `:active` does: style
  both (`:is(:active, .pressed)`).
- Menus, the project list and search's rows are 44px on any touch screen (`@media (pointer: coarse)`,
  `responsive.css`), not only in the app: a phone browser's thumb is the same size.
- Search (⌘K's palette) is a sheet from the top on a narrow screen, as tall as the screen allows, so
  the keyboard never covers the end of its list.
- Menus open over the keyboard's half of the screen otherwise: `popover()` (`web/js/ui/popover.js`)
  puts the keyboard away when a button opens one, and `fitToScreen` keeps every popover inside the
  visual viewport (above or below its button, scrolling inside), again on every resize. Pick with
  `refocus(back)`, not `back.focus()`, so a touch screen doesn't get the keyboard back.
- A name the user chose (a computer, a machine) has a max-width and ends in `…` wherever it sits in
  a bar or a menu row: `Mokhless-MacBook-Pro-Studio-Workstation` must not push buttons away.
- A panel with a leading icon (the working panel's orb) keeps the icon beside its first line only:
  what's under it (a question, its answer box) takes the panel's whole width.
- An icon-only button sits centred in its 44px; its pressed or hover background is a smaller square
  (`background-clip: content-box`) whose edge lines up with the content above it. A tap leaves no
  hover background behind (`@media (hover: none)` in `responsive.css`).
- Nothing is hover-only on touch: a control that appears on hover on desktop is always shown, or
  reachable another way.
- No keyboard hints on touch screens: `kbd`, `.key-hint`, the palette footer, *Press ⌘L*, the
  *Keyboard shortcuts* entry. Wrap key text you add in `.key-hint` so the existing rules hide it.

## Swiping rows

- In the app only (`MOBILE`, `swipe.js`): a phone browser keeps its own sideways gestures.
- Right is *Mark done* / *Reopen*, left is *Save for later* / *Unsave*: both undoable, so neither
  asks. A spell may pick *Archive* or *Delete task* (`card.swipeRight` / `swipeLeft`); a swiped
  delete has no dialog, it waits for its Undo toast instead.
- The band under the row says the action in the same words as the menus, warms with the pull and
  fills (with a tick, `VIBRATE`) past a third of the row or on a flick. A row the action can't apply
  to (a running task) only gives a little, with no label.
- Swipes starting within 24px of the screen's edge are Android's Back; a vertical drag is a scroll.
- No nudge teaches it; a tip on the computers screen does.

## The app

- The app's own screen (`mobile/www/`) and the grid's device pages (`/activate`, *Device connected*)
  use **48px** targets, Android's own size (Play's pre-launch accessibility check flags less); wisp's
  page in the app keeps 44px.
- Signing in to wisp Cloud is one tap everywhere in the app (*Continue with GitHub* / *Google*);
  a grid address is only asked for behind *Use your own wisp Grid*.
- Each wisp Cloud account is one card: its picture with the GitHub or Google mark it signs in with,
  the handle, and that account (`@login` or the email) under it; never *wisp Cloud* on every row
  (a grid's name shows only when it isn't wisp Cloud). Its computers are rows in the same card.
- Where a row stands is a dot and a word under its name (*Online*, *Offline*, *Over SSH*), never a
  disabled button. *Over SSH* stays whole; the address after it ends in `…`.
- Store-required destructive paths (*Delete your account*) are a quiet `--bad` underlined link
  under *Sign out*, 48px tall, never a filled button; they open the grid's own page for it
  (`/account#delete`), which does the confirming.
- It opens on the **computers list**, never straight into the last computer. The wisp logo in the
  top bar goes back to it (a browser's logo stays the way home); the list has no Back button of its
  own, the phone's Back returns.
- **Back** closes the newest dialog, menu or open task, then leaves the computer. Anything that opens
  and should close on Back registers with `onBack(close)` (`web/js/ui/back.js`); `popover()` and
  overlays already do.
- The list fills the screen. A task opens as a page of its own (`split.js`), its head Back, the
  title (two lines at most) and the `split.head` slot; Back returns to the list where it was. It
  takes one history entry while it shows (`onBack`), however many tasks you go through on it.
- *New task* is the floating button (`fab.js`) over the list (the list's own New task row is hidden
  in the app): it opens home as a page, the prompt box focused. Sending goes back to the list, where
  the new task shows; Back leaves it, and the draft stays.
- The app starts on the list, never inside a task it had open.
- Name the computer you're on with `HERE` / `here` (`state.js`), never a literal *This computer*: in
  the app it's the computer's name (*Studio*).
- Hide desktop-only actions with `MOBILE` (*Open project in editor*, the layout switch, keyboard
  shortcuts), not by width; or give them a phone version (the terminal opens inline).
- Keep `server/machines/bootstrap.js` and `server/shq.js` free of Node imports: the app runs them.
- The page is cached for good by content hash: a new module or stylesheet needs nothing extra, but
  test that a stale cached page reloads onto the new build.
- Check it with `node qa/mobile.mjs` (the app's WebView as a page) and the `MOB-*` scenarios in
  `qa/scenarios/mobile.md`.
