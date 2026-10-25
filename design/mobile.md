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

## Touch

- In the app, touch targets are at least 44px (an invisible `::before` can grow a 32px pill's hit
  area). Buttons get a press state (`scale(0.96)`), rows an active background.
- Nothing is hover-only on touch: a control that appears on hover on desktop is always shown, or
  reachable another way.
- No keyboard hints on touch screens: `kbd`, `.key-hint`, the palette footer, *Press ⌘L*, the
  *Keyboard shortcuts* entry. Wrap key text you add in `.key-hint` so the existing rules hide it.

## The app

- It opens on the **computers list**, never straight into the last computer.
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
- Hide desktop-only actions with `MOBILE` (*Open project in editor*, the layout switch, keyboard
  shortcuts), not by width; or give them a phone version (the terminal opens inline).
- Keep `server/machines/bootstrap.js` and `server/shq.js` free of Node imports: the app runs them.
- The page is cached for good by content hash: a new module or stylesheet needs nothing extra, but
  test that a stale cached page reloads onto the new build.
- Check it with `node qa/mobile.mjs` (the app's WebView as a page) and the `MOB-*` scenarios in
  `qa/scenarios/mobile.md`.
