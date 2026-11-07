# Install gate

Every way into wisp, on real artefacts, before and after the switch from Electron. Run
`node desktop/scripts/package.mjs` (needs Rust), then `node qa/install.mjs [--artefacts dist/tauri]
[--only npm,script,brew,app,links]`. It publishes nothing: npm installs come from `npm pack`'s tarball
into temp prefixes, `install.sh` reads a registry and a release folder served by the script, HOME is
a temp folder. A row with no artefact says *NOT RUN*; it never passes. The table goes to
`qa/out/install.md`. A release dry run (`gh workflow run release --ref <branch> -f dry_run=true`) runs
this on macOS, Windows and Linux through `.github/workflows/tauri-package.yml`.

| Scenario | Electron today | Tauri |
|---|---|---|
| INST-01 `npm pack` | Automated | Same tarball: `desktop/` stays off npm |
| INST-02 `npm i -g`, no Electron | Automated: `--version`, `--no-open`, words, `--browser`, tab | Same |
| INST-03 `npm i -g`, with Electron | Automated; the window through `--user-data-dir`, see below | npm stays Electron until the stable switch |
| INST-04, 05 `npx`, without and with Electron | Automated | Same |
| INST-06 `install.sh`, `WISP_VERSION=next` and `nightly` | Automated | Same |
| INST-07 `install.sh` with no Node | Automated | Same |
| INST-08, 09 Homebrew formula | Read through; its steps run in a temp Cellar. A real `brew install`: Manual | Same |
| INST-10 SHA256SUMS.txt | Same lines as release.yml | Automated |
| INST-11, 12 `install.sh --app` | Same script | Automated: no Node on PATH, Node's executable bit, a bad sum refused |
| INST-13 dmg | | Automated: holds wisp.app and Applications, Node runs from the image |
| INST-14, 15 the app, direct and by `open -n` | DESK-01 | Automated: server on the bundled Node, none on PATH, `method: app`, no orphan after kill -9 |
| INST-17 the app through a symlinked folder | Works | Automated: Tauri refuses `resource_dir()` there, so the shell reads the real path |
| INST-15c as Finder starts it | | Automated: launchd's PATH, no node, agents from the login shell |
| INST-16, 16b self-update | Manual | Automated: the running app downloads a newer zip, swaps itself and reopens. 16b is all inside the app: `POST /api/update`, its hand-off, the real `open`; only the release list is stood in for |
| INST-18 Electron→Tauri self-update | | Automated with `--old-electron <zip>`, in a dry run from that run's Electron build |
| INST-19 the shell as Electron's helper | | Automated: `ELECTRON_RUN_AS_NODE=1 wisp -p` is the bundled Node |
| INST-20–22, 24 Windows installer | Manual | CI (dry run): `/S` per user, `resources\app`, `node\node.exe`, `method: app`; `/S /R` (a Tauri app) and `/S --force-run` (a build already out) each start it again |
| INST-23 the update line on Electron's installer | CI probe, run by hand: the checks below | Not this row: INST-22, 24 |
| Linux AppImage, .deb | Manual | Stays on Electron until WebKitGTK can tell a frame from the page |
| INST-30 download links | Automated: names checked, each link answers | Same names: the same links |
| Gatekeeper on a browser download | Manual | Manual: Open Anyway on a real quarantined file, ad hoc signature |
| Site Download button, clicked | Manual | Manual |

The Electron window (INST-03f, 05f) starts the binary `bin/wisp.js` would, with its own
`--user-data-dir`: Electron keeps that folder under the real home whatever `HOME` says, so bare `wisp`
would hit the lock of any wisp.app open on the Mac, quit and focus that one.

**Before the switch:** builds already out can't change, so the Tauri build answers them. On a Mac they
run their own binary as Node after the swap, and by then that's the Tauri shell: `macos::be_node_for_electron`
makes it Node for that one run. On Windows they run `/S --force-run`: Tauri's installer knows only `/R`,
and `desktop/src-tauri/installer-hooks.nsh` gives it the other word. A Tauri app sends `/R`, an Electron
build still `--force-run`. Left open: the two install to different folders (`%LOCALAPPDATA%\Programs\wisp-agents`
and `%LOCALAPPDATA%\wisp`), so Electron's copy and its shortcuts stay behind until something removes them.
The whole Electron→Tauri update on Windows hasn't been run: INST-24 is its last step only.

**INST-23, Electron's NSIS installer and the updater's line.** An Electron build sends `/S --force-run`;
this was last run on the longer `/S --force-run /R`, with `--force-run` alone as a row of it. On `windows-latest`, in a throwaway workflow on a branch, take a
release's `wisp-windows-x64-setup.exe` and a dry run's (`gh run download <id> -n desktop-Windows`). Build
the line with `Updater.relaunchCommand()` and start it the way `server/update.js` does: its `WAITER`
source, then the app is killed. Check, per row:

- over an older copy, over the same version and on no copy: the new version is in place, exit 0
- the app comes back by itself, on port 4477, with no arguments (`/R` isn't passed on), one `wisp.exe`
- `/S --force-run` without `/R`, same base: same file hashes, uninstall key, shortcuts and argv
- `/S` and `/S /R`: exit 0, installed, the app stays down, so `--force-run` is what starts it
- still in `%LOCALAPPDATA%\Programs\wisp-agents`, with the data in `%APPDATA%\wisp-agents` kept
- no window from the installer, its uninstaller or `cmd` (poll EnumWindows from the same session)

Also over a running copy, and with the installer in a temp folder holding spaces, `(` and `&`. Last run
2026-11-07 on windows-2025-vs2026, x64, 15 rows, all as above: 0.56.0, 0.57.0, nightly 20261106.1129
and dry run 42347471229 ([probe](https://github.com/M0xoo/wisp/actions/runs/42350088213)). Not covered:
arm64, Windows 10, a UAC prompt (off on the runner), and the app quitting by itself after Update.
