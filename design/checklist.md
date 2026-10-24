# Before you hand back a UI change

Copy this into your notes and tick it off. A UI change isn't verified until it has been seen.

## Look at it

- [ ] Rendered in real Chrome (not reasoned about from the CSS) at **1440px**, **1000px** and
      **390px** wide.
- [ ] In **light and dark**.
- [ ] In **split view and the feed** (and split view's home, if you touched the launcher or Needs you).
- [ ] In the **phone app's** page if it shows there (`node qa/mobile.mjs`, or `body.wisp-mobile` with
      the `wispMobile` user agent).
- [ ] A screenshot of the result goes in the reply / PR.

Use the QA runners rather than your own wisp: they start an isolated wisp with fake agents
(`node qa/web.mjs`, `qa/mobile.mjs`, `qa/desktop.mjs`; see `qa/README.md`). For a one-off check,
install `playwright-core` in `/tmp` (not the repo) and launch the system Chrome with
`executablePath`. Look at the screenshots, not only the exit code: layout regressions at phone width
or in dark mode don't throw.

## Behaviour

- [ ] The click shows its result at once; a server refusal rolls back with a red toast.
- [ ] Inputs clear on send.
- [ ] Opening, selecting or hovering a row moves nothing in it; times and pills stay in their columns.
- [ ] A live refresh (another task finishing) doesn't move what you're reading or replay animations.
- [ ] No empty or piece-by-piece loading state.
- [ ] Toasts and floating buttons don't cover the reply box or Send.
- [ ] Keyboard: Tab reaches it, the focus ring shows, Escape closes it and puts focus back.
- [ ] Phone: nothing sticks out at 390px, no keyboard hints on touch, 44px targets in the app, Back
      closes it.

## Consistency

- [ ] Uses tokens and the form kit; no hard-coded colours, no new font size or control style.
- [ ] A new task action is in the right-click menu, More, the details column, the palette and keys,
      with the same name.
- [ ] Words match [copy.md](copy.md).
- [ ] Reachable from a spell: slot / part / prop / setting / icon added and tested in
      `test/spells.test.js` (AGENTS.md).

## Paperwork

- [ ] `CHANGELOG.md` → *Unreleased* line for anything a person would notice.
- [ ] The flow's scenario in `qa/scenarios/` updated if you changed a flow it covers.
- [ ] `npm test` passes (new test files listed in `package.json`).
- [ ] For an audit or polish task: only how it looks and feels changed, never what a feature does.
- [ ] Say honestly what you didn't check (e.g. "not run in the Android app").
