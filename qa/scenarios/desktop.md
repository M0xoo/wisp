# Desktop app (Electron) scenarios

The desktop app is `electron/main.js`: it starts wisp's server inside Electron's main process (or
attaches to one already on the port) and opens one window on `http://localhost:<port>`.
`electron/preload.cjs` gives the page `window.wispDesktop`.

Run the automated ones from the repo root (needs `npm install` for Electron, and playwright-core in
`/tmp/wisp-qa-pw`, see `qa/lib.mjs`):

```sh
node qa/desktop.mjs        # DESK-01…14, screenshots in qa/out/desktop-*.png
node qa/desktop-tauri.mjs  # the Tauri shell, TAURI-*, macOS with Rust
node qa/desktop-tauri-win.mjs  # the Tauri app on Windows, TAURI-W*, CI only (tauri-windows.yml)
```

Each app it starts has its own `WISP_HOME`, port (4521, 4522) and `--user-data-dir`. That matters:
the checkout's package name is `wisp-agents`, the same as an installed or dev wisp.app, so without
its own user-data dir a second app hits `requestSingleInstanceLock()`, quits, and focuses yours.
It also drops `WISP_DEV` (dev mode pins `--remote-debugging-port=9339`) and points
`WISP_*_BIN` at wisp's fake agents, because `inheritShellPath()` replaces `PATH` with the login
shell's.

## The Tauri shell, beside Electron

`desktop/` runs the same page in the system WebView with the unchanged server as a Node child. Users
don't get it yet. `node qa/desktop-tauri.mjs` (macOS, needs Rust, runs its own build with the QA
driver `desktop/src-tauri/src/qa.rs`) is the Tauri column below: AppKit events go through NSApp, so
they take a real key's road through the menu, but they aren't a hand on a keyboard. Switching needs all
of this on macOS, Windows and Linux, `qa/web.mjs` on each engine and one Electron→Tauri self-update seen.

| Scenario | Electron | Tauri (macOS) |
|---|---|---|
| DESK-01 boots | Automated | TAURI-01: the server is the shell's Node child |
| DESK-02 window | Automated | TAURI-02 |
| DESK-03 title bar | Automated; dragging Manual | TAURI-03 (buttons at x 16, y 18), TAURI-16: which spots ask to drag, double-click zooms, the title band moves; a drag by a real mouse: Manual |
| DESK-04 console | Automated | TAURI-04 |
| DESK-05 bridge | Automated; picker Manual | TAURI-05; picker Manual |
| DESK-06 links | Automated | TAURI-06; TAURI-06b previews and sandboxed frames stay put; TAURI-17 IPC refused off wisp's origin and port |
| DESK-07 menu | Automated; keys Manual | TAURI-07: menus, typing, ⌘A ⌘C ⌘X ⌘V ⌘Z in the prompt box, ⌘Q; TAURI-19: View's Reload, Force Reload, Toggle Developer Tools |
| DESK-07b ⌃Tab | Manual | TAURI-07b: the key reaches the page; tap and hold: Manual |
| DESK-08 theme | Automated | TAURI-08 |
| DESK-09 badge | Automated | TAURI-09 |
| DESK-10 a task | Automated | TAURI-10, TAURI-10b stacked |
| DESK-11 updater (git) | Automated | TAURI-11 |
| DESK-12 second launch | Automated | TAURI-12 |
| DESK-13 quit | Automated; close and reopen Manual | TAURI-13: close hides, a launch brings it back, ⌘Q stops agents cleanly; TAURI-21: a stuck server is killed at the 5 s limit; Dock reopen: Manual |
| DESK-14 attach | Automated | TAURI-14 |
| DESK-15 context menu | Manual | TAURI-20: the menu AppKit opens on a link and in a text box; choosing an item and no Inspect in a release build: Manual |
| (none) | | TAURI-10c `<a download>` goes to ~/Downloads without asking; TAURI-15 kill -9 leaves no orphan |
| (none) | | TAURI-07c Tab reaches buttons and links; TAURI-07d Tab from the top of a task lands on a question's first answer, Return answers; TAURI-18 a task behind a closed window notifies, the delegate a click reaches opens it; TAURI-18b with another app in front; TAURI-22 a CLI added to the login shell is found without a restart; TAURI-23 a file through `NSDraggingDestination` on the real view |

**Still by hand, on the gate:** a real banner on screen and clicking it opens the task (from a built `wisp.app`, after *Allow*); dragging the window with a mouse; a file dragged from Finder; a right-click menu item chosen; the Dock reopen; ⌃Tab held.

The bundled Node and an update don't work yet (PR 3).

Notifications (TAURI-18): the page's `new Notification` lands in `tauri-plugin-notification` through
`src/init.js` and `src/notify.rs`. The check reads what macOS holds and calls the delegate a click would
reach: the click on a banner itself is Manual. A debug build shows them under Terminal's name; a
built `wisp.app` as itself, once *Allow* is pressed on macOS's own card (System Settings →
Notifications → wisp).

**Linux.** WebKitGTK's `decide-policy` doesn't say which frame a navigation is for and wry calls
`on_navigation` for all of them (Windows' `NavigationStarting` is the main frame's, macOS answers frames
first in `macos.rs`). So on Linux every navigation goes through, and `src/linux.rs` decides at the response, the one
decision WebKitGTK marks as the main frame's: a page from outside wisp is refused (wisp's page stays) and
its address opens outside; a scheme with no response (`vscode://`) fails the main frame's load and opens
outside from there. `node qa/desktop-tauri-linux.mjs` (ubuntu-latest under Xvfb, `tauri.yml`):

- **TAURI-L01** boots on WebKitGTK, the server is a Node child, no page errors.
- **TAURI-L06b** a Preview frame that moves on its own (a script, a meta refresh, then to another site),
  one the page moves, a sandboxed one, srcdoc frames: all stay in their frame, nothing opens outside, and
  a sandboxed frame can't move the page.
- **TAURI-L06** a clicked link, `location.href` to another site, `vscode://` and a popup open outside; a
  `file:` URL never; wisp stays on its page, unreloaded. The other site sees the page's own move once
  before it's stopped (Electron's `will-navigate` stops it before the request): the log says what it saw.

## The Tauri app on Windows

`.github/workflows/tauri-windows.yml` builds the installer on windows-latest (`package.mjs --features
qa`) and runs three jobs on it, each on a clean runner: `qa/desktop-tauri-win.mjs` (TAURI-W*),
`qa/web.mjs` in Chrome and then in the app's own WebView2, and the move from a real v0.57.0
(`qa/scenarios/install.md`, INST-40–46). The `qa` feature adds one thing on Windows: `WISP_QA_CDP`
opens WebView2's DevTools port, which `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` and its policy can't once
wry names arguments of its own (tried, on the runner). The page is driven by Playwright over CDP;
the window, mouse, keys, taskbar, menus and links by Win32 (`qa/win32.ps1`): a real pointer, real
keys through `SendKeys`, the menu bar read with `GetMenu`, the taskbar compared pixel for pixel.
Playwright makes every page say it has focus, so the focus checks let go of it and ask over a bare
DevTools socket. The numbers it compares with are v0.57.0's, measured on the same runner.

| Scenario | Electron (v0.57.0, measured) | Tauri (Windows) |
|---|---|---|
| DESK-01 boots | in the main process | TAURI-W01 ran: the server is the shell's child on the bundled `node\node.exe`, `method: app`, body `electron other` |
| DESK-02 window | 1380×900 whole, centred (270,66 at 1920×1080); 1366×720 at 0,0 on a 1366×768 screen | TAURI-W02 ran: the same rects; a corner dragged in by a real mouse stops at a page of 720×520. TAURI-W02b ran: the 1366×768 laptop |
| DESK-03 title bar | Windows' own; a real drag on the top bar leaves the window where it is | TAURI-W03 ran: Windows' own bar, no Mac insets; a real drag and a double-click on the page's top bar do nothing, a double-click on the real title bar maximizes and restores |
| DESK-04 console | | TAURI-W04 ran |
| DESK-05 bridge | | TAURI-W05 ran: `pickFolder` only, no `require`, no Get the app; the real folder dialog titled *Add project*, Esc gives null. Its button says *Select Folder*: Windows' own word, Manual to change |
| DESK-06 links | | TAURI-W06 ran: `window.open`, `target=_blank` and a navigation go out through Windows' own protocol handler (a QA scheme and `vscode://`), `file://` doesn't, the window stays. TAURI-W06b ran: previews stay in their frame; a frame's `invoke` is refused (`not allowed by ACL`, sandboxed: `Origin header is not a valid URL`). TAURI-W17 ran: another port and `127.0.0.1` refused |
| DESK-07 menu | File, Edit, View, Window | TAURI-W07 ran: the same four, nothing greyed out, real typing and Ctrl+A C X V Z in the prompt box. TAURI-W07c ran: Ctrl+= Ctrl+- Ctrl+0, F11 and Ctrl+M do what the menu says |
| DESK-07b Ctrl+Tab | | TAURI-W07b ran: a real Ctrl+Tab reaches the page; held: Manual |
| DESK-08 theme | | TAURI-W08 ran: the system switched to dark and back, live |
| DESK-09 count | a badge on the taskbar icon, 99+ past 99 | TAURI-W09 ran: the taskbar's pixels change with (3) and (127) and come back without; the window keeps `wisp` (`qa/out/desktop-tauri-win-bar-*.png`) |
| DESK-10 a task | | TAURI-W10 ran, TAURI-W10b ran (stacked at 800px) |
| DESK-12 second launch | | TAURI-W12 ran: it exits, and brings a minimized first one back |
| DESK-13 quit | closing quits | TAURI-W13 ran: a real click on X with an agent running: the shell, the server and the agent go, port closed, `server.json` removed. TAURI-W21 ran: a stuck server is killed at the 5 s limit |
| DESK-14 attach | | TAURI-W14 ran |
| DESK-15 context menu | Copy Link, editing, Select All | TAURI-W20 ran: what WebView2 offered (from the shell, no automation reads its menu) and a picture of what's left. Choosing an item and spelling suggestions: Manual |
| (none) | | TAURI-W15 ran: the shell killed (`taskkill /F`, no `/T`) leaves no server, agent or port. TAURI-W18b ran: Notepad in front: one blur, from WebView2. TAURI-W18: a minimized window's finished task is a toast in Action Center, and a real click on it opens the task |
| qa/web.mjs | | ran in the app's WebView2 (`QA_ENGINE=webview2`, `Edg/156`) and in Chrome on the same runner |

**Manual on Windows:** a toast clicked once it has gone to Action Center (the plugin only hears a click
while it's on screen; Electron's is no better), a file dropped from Explorer, spelling suggestions,
SmartScreen's *Run anyway* on a real download, high DPI (a runner has one 100% display), Windows on
arm64 (built by tauri-package.yml, run nowhere), and the Electron→Tauri update from a real GitHub release (INST-46 runs v0.57.0’s own update, with only its release list served locally).

What the Windows shell does that Electron does by itself (`src/windows.rs`, `src/init.js`, measured
on v0.57.0 first):

- The window is 1380×900 as a whole, centred and kept on the screen. Tauri's size is the page's,
  wherever Windows puts it: past a 1366×768 laptop's edge and under its taskbar.
- The count is a badge on the taskbar icon. Tauri's `set_badge_count` does nothing on Windows, so the
  shell draws one (`set_overlay_icon`), dark with white digits and 99+, as Electron's.
- `-webkit-app-region` is off. Electron's framed window ignores it; WebView2 honours it, so the
  page's top bar dragged the window and ate clicks.
- WebView2 runs injected scripts in every frame: `init.js` stops in a frame, so a preview has no
  bridge. Tauri's own IPC is there too, and checks the frame's origin: refused off wisp's.
- `Notification.permission` is the plugin's from the first page. It was `default`: WebView2 runs each
  script to its end, so the plugin had answered before `init.js` replaced `Notification`.
- A minimized window has no focus. WebView2 kept saying it had, and `notify.js` stays quiet then.
- The keys of the View and Window menus: a key pressed in the page goes to WebView2's process and
  never reaches the menu bar, so the shell hands Ctrl+= Ctrl+- Ctrl+0 F11 Ctrl+M on.
  `CmdOrCtrl+Plus` was never a key muda knows: Zoom In had none, on macOS too; it's `=` now.
- Toggle Full Screen is the shell's own item (F11): muda greys out the built-in one on Windows.
- The right-click menu leaves out what a browser has: Back, Refresh, Save as, Print, More tools,
  Emoji, Writing direction. A menu with nothing left doesn't open.
- The toast has no *Open* button: macOS needs an action to hear a click, Windows doesn't.
- WebView2 fires its own focus and blur, so the shell doesn't tell it too.

## DESK-01 · Boots and starts its own server
- **Preconditions:** nothing listening on the port.
- **Steps:** `WISP_PORT=4521 electron . --user-data-dir=<tmp>`.
- **Expected:** the port answers `/api/health` with the Electron main process's pid; the window
  loads wisp (launcher / split home) and the body has `electron` (and `mac` on macOS).
  The first open (no saved `shell-path` in the user-data dir) waits for the login shell's `PATH`
  at most 5 s, even when `~/.zshrc` is slow: a window that takes longer is a bug
  (`test/shell-path.test.js`).
- Automated: qa/desktop.mjs

## DESK-02 · Window title, size, minimum size
- **Steps:** look at the window.
- **Expected:** one visible window titled `wisp` (the page's "(n) wisp" title doesn't replace it),
  1380×900 or the screen's size if smaller, can't be resized below 720×520.
- Automated: qa/desktop.mjs

## DESK-03 · Title bar on macOS (hiddenInset)
- **Steps:** in split view with the crew rail, with the list hidden (`[`), and in a window under 900px wide (stacked: the
  list, then a task's page with Back), look at the top-left.
- **Expected:** nothing clickable under the traffic lights (x 12–76, y 10–36): the brand and the
  topbar buttons sit to their right. With the rail the lights, the sidebar button, search and you
  share a strip on the rail's surface, no logo; the list's panel starts under it, level with the
  first face. The strip drags the window too. The top bar (and split head) drags the window; its buttons
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

## DESK-07b · ⌃Tab reaches the page
- **Steps:** with 3+ tasks and the app focused, press the real ⌃Tab on the keyboard, then hold Ctrl and press Tab twice.
- **Expected:** the Window menu doesn't take the key: the task switches. ⌃⇥ shows in the shortcuts dialog (`?`) here and not in a browser tab.
- Manual

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

## The page on WebKit (Tauri)

The Tauri app shows the same page in WKWebView on a Mac. `QA_ENGINE=webkit node qa/web.mjs` and
`QA_ENGINE=webkit node qa/views.mjs` run it on Playwright's WebKit, which is close to Safari but
isn't a WKWebView: what only the app can show is under *Not seen yet*.

**Lowest version: Safari 16.4, macOS 13.3.** The Tauri config says so (`minimumSystemVersion`).

| Needs | Since | Without it |
|---|---|---|
| `color-mix()`, 174 uses | Safari 16.2 (macOS 13.1) | The declaration is dropped: backgrounds, borders and tints go. macOS 13.0 has Safari 16.1, so this alone rules it out |
| `lh`, `@property`, import maps | Safari 16.4 (macOS 13.3) | A row's height in the panel, an orb's animation, and the scripts' cache names |
| `@container`, `overflow: clip`, `AbortSignal.timeout` | Safari 16.0 | Covered by the above |
| `:has()`, `dvh`, `.at()`, `findLast`, `structuredClone` | Safari 15.4 | Covered by the above |

16.4 was run for real: Playwright 1.33's WebKit 16.4 build passes `web.mjs` and `views.mjs`. 16.0
builds don't start on macOS 15, so 16.2 and 16.3 are read from the table, not run. Electron runs on
older Macs than this: a loss to weigh at the switch.

Newer features the page does without on an older Mac:

| Feature | Since | On older versions |
|---|---|---|
| `:user-invalid` | Safari 16.5 | No red border after leaving a bad field; `aria-invalid` still gives it |
| `::highlight`, `Highlight` | Safari 17.2 | Comments aren't marked on an answer's text (`comments.js` checks for it) |
| `scrollbar-width` | Safari 18.2 | `::-webkit-scrollbar` does the same |

### What stays different

| Difference | On | Why it's left |
|---|---|---|
| Tab skips buttons and links, stops at text boxes and `tabindex` | Safari, Playwright's WebKit | Safari's default. Not in the app: wry and the shell turn on `tabFocusesLinks` (`WKPreferences`, `macos::tab_reaches_links`), so Tab reaches a question's answers as in Electron (TAURI-07c, TAURI-07d) |
| Clicking a button doesn't focus it: `relatedTarget` is null, focus goes to `body` | WebKit | Safari's default. Every `focusout` handler was read: none depends on it. Focus still returns on Escape |
| No scroll anchoring | WebKit 16.4. Playwright's 27.2 has it; which Safari ships it isn't clear | The page holds still by hand: forced off on 27.2, the list moved 0.5 px as in Chrome and a reader's scroll came out the same. A late image above the reader would move them |
| `content-visibility` off on list rows | WebKit | It left rows outside the list. A list of hundreds costs more to restyle |
| Copying more than about 5 s after the click is refused (measured: fine at 1.5 s, refused at 7.5 s) | WebKit | Only a copy that waits on the server can hit it. Publish and Launch still say the link |
| A terminal's scrollbar is 10 px, not 15 | WebKit | Chrome's comes from `scrollbar-color`, which WebKit doesn't have. Worth at most a column |
| Text wraps a line sooner or later in a few places | Either | Text widths differ by a fraction of a pixel |
| A 10 px sideways scroll in Settings at 390px | WebKit | A stale width: nothing overflows. The app's window can't get under 720 px |
| QA log only: `Refused to apply a stylesheet`, and `due to access control checks` | WebKit | The first is Playwright's screenshot style in a frame with a CSP, the second a fetch cut off by a reload. Neither is the page's, so `web.mjs` ignores them |

### Not seen yet (needs the real app)

A notification's banner and a click on it, window drag by a mouse (`-webkit-app-region`), real IME input
(`WEB-64` sends the keydown as Safari does), a real file dragged from Finder (TAURI-23 stops at AppKit's
drop calls), `<input type="file">`, and clipboard rules inside WKWebView.
