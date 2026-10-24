# Desktop app (Electron) scenarios

The desktop app is `electron/main.js`: it starts wisp's server inside Electron's main process (or
attaches to one already on the port) and opens one window on `http://localhost:<port>`.
`electron/preload.cjs` gives the page `window.wispDesktop`.

Run the automated ones from the repo root (needs `npm install` for Electron, and playwright-core in
`/tmp/wisp-qa-pw`, see `qa/lib.mjs`):

```sh
node qa/desktop.mjs        # DESK-01…14, screenshots in qa/out/desktop-*.png
```

Each app it starts has its own `WISP_HOME`, port (4521, 4522) and `--user-data-dir`. That matters:
the checkout's package name is `wisp-agents`, the same as an installed or dev wisp.app, so without
its own user-data dir a second app hits `requestSingleInstanceLock()`, quits, and focuses yours.
It also drops `WISP_DEV` (dev mode pins `--remote-debugging-port=9339`) and points
`WISP_*_BIN` at wisp's fake agents, because `inheritShellPath()` replaces `PATH` with the login
shell's.

## DESK-01 · Boots and starts its own server
- **Preconditions:** nothing listening on the port.
- **Steps:** `WISP_PORT=4521 electron . --user-data-dir=<tmp>`.
- **Expected:** the port answers `/api/health` with the Electron main process's pid; the window
  loads wisp (launcher / split home) and the body has `electron` (and `mac` on macOS).
- Automated: qa/desktop.mjs

## DESK-02 · Window title, size, minimum size
- **Steps:** look at the window.
- **Expected:** one visible window titled `wisp` (the page's "(n) wisp" title doesn't replace it),
  1380×900 or the screen's size if smaller, can't be resized below 720×520.
- Automated: qa/desktop.mjs

## DESK-03 · Title bar on macOS (hiddenInset)
- **Steps:** in split view, with the list hidden (`[`), and in the feed (`\`), look at the top-left.
- **Expected:** nothing clickable under the traffic lights (x 12–76, y 10–36): the brand and the
  topbar buttons sit to their right. The top bar (and split head) drags the window; its buttons
  still click.
- Automated: qa/desktop.mjs (hit-test under the lights, `desktop-lights-*.png`). Dragging the
  window by the top bar: Manual.

## DESK-04 · No console errors on load
- **Expected:** no page errors or console errors while the page loads.
- Automated: qa/desktop.mjs

## DESK-05 · Preload bridge
- **Expected:** `window.wispDesktop` has exactly `pickFolder`; Node's `require` isn't in the page;
  *Get the app* is hidden. `pickFolder()` resolves to the chosen folder (or `null` when cancelled).
  In the launcher, *Add project* shows **Browse…** and the native picker says *Add project*.
- Automated: qa/desktop.mjs (dialog stubbed). The real native picker: Manual.

## DESK-06 · Links leave the app
- **Steps:** `window.open('https://…')`, click a `vscode://…` editor link, navigate to an outside URL.
- **Expected:** each goes to `shell.openExternal` (default browser / editor); no second window, and
  the window stays on wisp. Links to wisp itself (`http://localhost:<port>/…`) open inside.
- Automated: qa/desktop.mjs (openExternal stubbed)

## DESK-07 · Application menu
- **Expected:** macOS: wisp (app menu), File, Edit, View, Window; Windows/Linux the same without
  the app menu. ⌘C/⌘V/⌘A work in the prompt box; View → Reload and Toggle Developer Tools work.
- Automated: qa/desktop.mjs (menu roles). Shortcuts: Manual.

## DESK-08 · Follows the system theme
- **Steps:** switch macOS Appearance (or `nativeTheme.themeSource`) between light and dark.
- **Expected:** the page follows at once (theme setting *System*); text stays readable in both.
- Automated: qa/desktop.mjs (`desktop-light.png`, `desktop-dark.png`)

## DESK-09 · Dock badge
- **Expected:** the dock badge shows the *Needs you* count from the page title; it clears at 0.
- Automated: qa/desktop.mjs

## DESK-10 · A task runs and its presentation renders
- **Steps:** launch a task on the fake Claude Code in a temp git repo; open it from the sidebar.
- **Expected:** it finishes in its own worktree (math.js fixed there), the card shows the hero
  and stats, the details column offers Transcript, Rerun, Take over, Ship it, Mark done, More.
- Automated: qa/desktop.mjs (`desktop-presentation.png`)

## DESK-11 · Updater in a git checkout
- **Expected:** `GET /api/update` → `method: "git"`, nothing available, `#updateBtn` hidden;
  `POST /api/update` refuses with *This copy of wisp is a git clone…*.
- Automated: qa/desktop.mjs

## DESK-12 · Second launch focuses the first
- **Steps:** start the app again with the same user-data dir.
- **Expected:** the second process exits; still one window, focused (restored if minimized).
- Automated: qa/desktop.mjs

## DESK-13 · Quitting stops the server it started
- **Steps:** quit (⌘Q).
- **Expected:** the port stops listening; running agents are stopped with it. Closing the last
  window on macOS keeps the app (and agents) running; the dock icon reopens the window.
- Automated: qa/desktop.mjs (quit). Close-window/reopen on macOS: Manual.

## DESK-14 · Attaches to a running wisp
- **Steps:** `node bin/wisp.js --no-open --port 4522`, then start the app on 4522; quit the app.
- **Expected:** the app shows that wisp (same pid behind `/api/health`), starts no server of its
  own, and quitting leaves the CLI's wisp running.
- Automated: qa/desktop.mjs

## DESK-15 · Context menu
- **Steps:** right-click a link, selected text, and the prompt box (with a misspelt word).
- **Expected:** *Copy Link* on links; Copy on selections; Undo/Redo/Cut/Copy/Paste/Select All in
  editable fields; spelling suggestions replace the word. *Inspect Element* only in dev (`npm run dev`).
- Manual

## DESK-16 · Dev mode reloads
- **Steps:** `npm run dev`, edit a file in `web/`, then one in `server/` while a task runs.
- **Expected:** a `web/` edit reloads the window; a `server/` edit relaunches the app only once
  nothing is running (the log says it's waiting).
- Manual

## DESK-17 · Packaged build
- **Steps:** build with `packaging/desktop/electron-builder.yml` (or take the latest release) for
  mac arm64/x64, Windows x64/arm64, Linux AppImage/.deb.
- **Expected:** it opens with no Node installed; agents found through the login shell's `PATH`
  when started from Finder/Dock; `GET /api/update` says `method: "app"`.
- Manual

## DESK-18 · macOS install path (unsigned)
- **Steps:** `curl -fsSL https://trywisp.dev/install.sh | bash -s -- --app`; separately, open the
  `.dmg` from a browser.
- **Expected:** the curl install lands in /Applications, checks SHA256SUMS.txt and opens without a
  prompt. The browser `.dmg` says it can't verify wisp; System Settings → Privacy & Security →
  *Open Anyway* opens it.
- Manual

## DESK-19 · Self-update of the app
- **Steps:** run an older packaged build with a newer release out (channel per Settings → General
  → Updates).
- **Expected:** *Update to x.y.z* appears in the top bar; clicking it asks first if agents run,
  downloads, swaps the app (`old.app` removed) and reopens on the new version. A download that
  isn't newer is refused with a message.
- Manual

## DESK-20 · Windows and Linux
- **Expected:** Windows: SmartScreen *More info → Run anyway*, the default title bar (no 88px
  inset), closing the window quits. Linux: `.deb` installs and updates by `.deb`; AppImage needs
  `chmod +x` (Ubuntu 24.04 may need `--no-sandbox`).
- Manual
