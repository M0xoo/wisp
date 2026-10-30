# QA

End-to-end scenarios for every surface wisp ships on, and scripts that run the automatable ones.
`npm test` checks the parts; this checks the product the way a person uses it, before a release or
after a change that touches more than one surface.

| Surface | Scenarios | Script | What it drives |
|---|---|---|---|
| Web (browser mode) | [scenarios/web.md](scenarios/web.md) (`WEB-*`) | `node qa/web.mjs` | `wisp --no-open` in Chrome: launcher, cards, questions, approvals, settings, spells, recipes, CLI, MCP, docs site |
| wisp Grid | [scenarios/grid.md](scenarios/grid.md) (`GRID-*`) | `node qa/grid.mjs` | `wisp grid dev --fake-agents`: sign-in, account, `/go`, cloud wisp, isolation, device flow, idle stop, admin commands |
| Desktop app | [scenarios/desktop.md](scenarios/desktop.md) (`DESK-*`) | `node qa/desktop.mjs` | `electron .` through Playwright's `_electron`: window, title bar, preload, links, theme, updater, attach, quit |
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
| desktop | 4520–4529 (`QA_DESKTOP_PORT` for the first app, 4521) |
| mobile | 4540–4549 |
| grid | 8090 (`QA_GRID_PORT`) |

They can run at the same time.

## Results

Each script prints a line per scenario id and exits non-zero on a failure. Screenshots,
logs and `<surface>.json` (id, pass/fail, error, time) go to `qa/out/` (`QA_OUT` to move it;
gitignored). A failing web check leaves `web-fail-<id>.png`. Look at the screenshots, not just the
exit code: layout regressions at phone width or in dark mode don't throw.
