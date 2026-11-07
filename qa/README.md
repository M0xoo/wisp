# QA

End-to-end scenarios for every surface wisp ships on, and scripts that run the automatable ones.
`npm test` checks the parts; this checks the product the way a person uses it, before a release or
after a change that touches more than one surface.

| Surface | Scenarios | Script | What it drives |
|---|---|---|---|
| Web (browser mode) | [scenarios/web.md](scenarios/web.md) (`WEB-*`) | `node qa/web.mjs` | `wisp --no-open` in Chrome: launcher, cards, questions, approvals, settings, spells, recipes, CLI, MCP, docs site |
| wisp Grid | [scenarios/grid.md](scenarios/grid.md) (`GRID-*`) | `node qa/grid.mjs` | `wisp grid dev --fake-agents`: sign-in, account, `/go`, cloud wisp, isolation, device flow, idle stop, admin commands |
| Desktop app | [scenarios/desktop.md](scenarios/desktop.md) (`DESK-*`) | `node qa/desktop.mjs` | `electron .` through Playwright's `_electron`: window, title bar, preload, links, theme, updater, attach, quit |
| Desktop app (Tauri, macOS) | [scenarios/desktop.md](scenarios/desktop.md) (`TAURI-*`) | `node qa/desktop-tauri.mjs` | builds `desktop/src-tauri --features qa` (needs Rust) and drives it through a local socket (`src/qa.rs`): WKWebView has no WebDriver |
| Android app | [scenarios/mobile.md](scenarios/mobile.md) (`MOB-*`) | `node qa/mobile.mjs` | the computers screen and wisp's page as the app's WebView sees it; APK, Gradle and emulator steps are in the scenarios |

Each scenario says how it's covered: **Automated** (the script), **Suite** (`npm test`),
**Gradle** / **Emulator** (Android steps in the scenario), or **Manual**.

## Setup

```sh
npm install                                        # Electron, for the desktop script
mkdir -p /tmp/wisp-qa-pw && npm i --prefix /tmp/wisp-qa-pw playwright-core
(cd mobile && npm install)                         # Capacitor's JS, for the mobile preview
```

Playwright stays out of the repo (wisp has no dependencies): the scripts load it from `PW_DIR`
(default `/tmp/wisp-qa-pw`) and drive the system Chrome (`CHROME` to use another). The grid needs
Node 22.13+.

## Isolation

Nothing touches your own wisp. Every script starts its own wisp with a temp `WISP_HOME`, its own
port and a temp git repo, with wisp's fake agents (`test/fixtures/fake-agent.mjs`) on PATH, so no
account is needed and nothing is billed. `qa/lib.mjs` drops `WISP_DEV`, `WISP_PORT` and
`WISP_DEBUG_PORT` from the environment, and refuses a port that's already taken (a wisp left from
an earlier run would answer with its own state). The desktop app gets its own `--user-data-dir`,
so a wisp.app you have open keeps its single-instance lock.

| Script | Ports |
|---|---|
| web | 4493 (`QA_WEB_PORT`) |
| buttons | 4497 (`QA_BUTTONS_PORT`) |
| ui-audit | 4498 (`QA_AUDIT_PORT`) |
| desktop | 4520–4529 (`QA_DESKTOP_PORT` for the first app, 4521) |
| desktop-tauri | 4761–4765 (`QA_TAURI_PORT`) |
| mobile | 4540–4549 |
| mobile-perf | 4550 (`PERF_PORT`) |
| desktop-perf | 4551 (`PERF_PORT`) |
| grid | 8090 (`QA_GRID_PORT`) |

They can run at the same time.

## Every button, every state

`node qa/buttons.mjs` opens 36 views of the page (New task and its menus, a task with its goal,
composer, transcript, Changes and More, crew, My Stuff, the palette, every Settings pane) at 1440,
1000 and 390px, light and dark, plus the phone app's page, and measures each visible button at
rest, hovered and keyboard-focused. It fails on an icon-only button that isn't square or whose icon
is off-centre, a centred label with uneven padding, buttons in one bar with boxes of different
heights, a label clipped without `…`, and buttons that overlap. Every measurement goes to
`qa/out/buttons.json`, and a contact sheet per view (each button at rest, hovered, focused) to
`qa/out/buttons/`. `QUICK=1` measures at rest only; `WIDTHS=390 THEMES=dark` narrows it.

## Every view, every size: the scorecard's numbers

`node qa/ui-audit.mjs` opens the same views as `buttons.mjs` (`qa/views.mjs`: New task and its menus
and pickers, a task with its goal, panels, dialogs and menus, crew and Org, My Stuff, the palette,
every Settings pane) at 1440, 1000 and 390px, at 390px on a touch screen and in the phone app,
light and dark, each in a fresh browser. In each it fails on an axe-core `wcag2a`/`wcag2aa`
violation, more than five font sizes (design/ui.md → Type), sideways overflow, a short label (≤ 24
characters) cut with `…`, and in the app a control under 44px. With a dialog open it measures the
dialog. Needs axe-core beside Playwright (`npm i --prefix /tmp/wisp-qa-pw playwright-core axe-core`).
Results go to `qa/out/ui-audit.json`, with a screenshot of each view that has an issue in
`qa/out/ui-audit/`. `WIDTHS=1440,app THEMES=dark VIEWS=home,task` narrows it. This is what
`design/scorecard.md` rows 3, 9, 13 and 14 are measured with.

## Speed in the phone app

`node qa/mobile-perf.mjs` times page changes as the app's WebView sees them (Done unfolded, tasks
opened and left with Back, New task) on a laptop, a slowed CPU (`pixel`) and a far-away tunnel
(`remote`: 250 ms per request, 5 Mbit/s; `bad`: 600 ms, 1 Mbit/s; `3g`: Chrome's 3G preset, 2 s, 400 kbit/s): tap to painted frame, the slow frames and the scripts in
them, the requests, the buttons in a task and the top bar, how soon a touched button or row looks
pressed, and a CPU profile's top functions, in `qa/out/mobile-perf.json`.
`PERF_SESSIONS=~/.wisp/sessions` runs it on a copy of real tasks (and that wisp's projects).
`PERF_STRESS=4000` with it clones them into 4,000 tasks plus a task of 400 turns and one with a
huge prompt and answer (`qa/stress-data.mjs`), and adds the stress steps: those opened and read,
the list flung, search typed into, a 130 KB prompt pasted, the connection lost and back. The `bad`
profile is 600 ms per request at 1 Mbit/s. Chrome's throttling applies to the page, not its service
worker, so the phone's first open (whose modules the worker fetches) looks faster there than it is.

## Results

Each script prints a line per scenario id and exits non-zero on a failure. Screenshots,
logs and `<surface>.json` (id, pass/fail, error, time) go to `qa/out/` (`QA_OUT` to move it;
gitignored). A failing web check leaves `web-fail-<id>.png`. Look at the screenshots, not just the
exit code: layout regressions at phone width or in dark mode don't throw.

## Speed in a desktop browser

As `qa/mobile-perf.mjs` does for the phone app, `node qa/desktop-perf.mjs` times the page at
1440×900 (the desktop app shows the same page): wisp's start, the cold load (first paint, the list, requests and bytes) and a reload, then
Done unfolded, tasks opened and opened again, New task, typing in the prompt box, the avatar menu,
Settings, search and a launch, each from the click or key to the frame that shows it, with a CPU
profile's top functions, in `qa/out/desktop-perf.json`. `PERF_SESSIONS=~/.wisp/sessions` runs it on
a copy of real tasks, `PERF_CPU=4` on a slowed CPU.
