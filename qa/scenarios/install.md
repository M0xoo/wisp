# Install gate

Every way into wisp, on real artefacts, before and after the switch from Electron. Run
`node desktop/scripts/package.mjs` (needs Rust), then `node qa/install.mjs [--artefacts dist/tauri]
[--only npm,script,brew,app,shell,links]`. It publishes nothing: npm installs come from `npm pack`'s tarball
into temp prefixes, `install.sh` reads a registry and a release folder served by the script, HOME is
a temp folder. A row with no artefact says *NOT RUN*; it never passes. The table goes to
`qa/out/install.md`. A release dry run (`gh workflow run release --ref <branch> -f dry_run=true`) runs
this on macOS, Windows and Linux through `.github/workflows/tauri-package.yml`.

| Scenario | Electron today | Tauri |
|---|---|---|
| INST-01 `npm pack` | Automated | Same tarball, plus `desktop/entry.mjs` (what the shell runs under `WISP_ROOT`) and `bin/desktop-shell.js`; no other `desktop/` file |
| INST-02 `npm i -g`, no Electron | Automated: `--version`, `--no-open`, words, `--browser`, tab | Same |
| INST-03 `npm i -g`, with Electron | Automated; the window through `--user-data-dir`, see below | npm stays Electron until the stable switch |
| INST-04, 05 `npx`, without and with Electron | Automated | Same |
| INST-25 `npm i -g`, no Electron, `wisp`: the shell alone | Electron if installed, else a tab | Automated (`shell`): `wisp-shell-<os>-<arch>.tar.gz` from a release served here (`WISP_SHELL_URL`), checked against SHA256SUMS.txt, into `$WISP_HOME/desktop/<version>/`; the server on this Node from the npm package, its parent the shell, `method: global`, no tab; on a Mac its window seen on screen (CGWindowList). Windows: the server, the window by hand |
| INST-26, 26b the next `wisp`, then kill -9 the shell | | Automated: no download (the release is gone), no server left behind |
| INST-27 a shell that doesn't match its sum | | Automated: a tab, and one line with the app's address; nothing kept |
| INST-28 no build for this platform (or offline) | | Automated: the same tab and line |
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
| INST-40–46 from Electron to Tauri on Windows | | CI (`tauri-windows.yml`, `--only migrate`): a real v0.57.0, then this installer, and v0.57.0's own update onto it, below |
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
build still `--force-run`. The two install to different folders, and the same hook takes Electron's copy away (INST-40–46 below,
INST-46 the whole update in v0.57.0's own code). The cmd.exe that update starts the installer from stands in
Electron's folder, so Windows keeps it until the installer is done: `desktop/remove-electron.mjs`, hidden on the
bundled Node, removes it then.

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

## From Electron to Tauri on Windows (INST-40–46)

The two install to different folders: electron-builder to `%LOCALAPPDATA%\Programs\wisp-agents` (it
takes the folder from package.json's `name`, not `productName`; seen on a real v0.57.0), Tauri to
`%LOCALAPPDATA%\wisp`. Without help an update leaves Electron's copy, its entry in *Apps* (two
*wisp*), and a taskbar pin that opens the old one. `desktop/src-tauri/installer-hooks.nsh` (Tauri's
`NSIS_HOOK_POSTINSTALL`) runs Electron's own uninstaller, silently and in place (`_?=`) with
`--keep-shortcuts`, and moves only the links that still point at the old `wisp.exe`. It keeps:
`~/.wisp` (the same home for both: os.homedir()), Electron's Chromium profile in
`%APPDATA%\wisp-agents`, and any link of the user's own. Tauri's own check for a running app only looks
in its `$INSTDIR`; Electron's uninstaller stops its copy, then gives up once while the files are still
in use, so the hook tries again (up to five times) and only then removes the uninstaller it ran from.

`node qa/install.mjs --only migrate` (CI only: it replaces the wisp on the machine) downloads the real
v0.57.0 installer from the release:

| Row | What it checks |
|---|---|
| INST-40 | v0.57.0 `/S`: `Programs\wisp-agents`, one entry in Apps, two links on it; a taskbar pin added |
| INST-41 | v0.57.0 runs a task on the fake agent: it lands in `~/.wisp`; the profile is in `%APPDATA%\wisp-agents` |
| INST-42 | the Tauri installer over it, as an update (`/S`): Electron's folder gone, one entry (`wisp`), desktop, Start and the pin all on `%LOCALAPPDATA%\wisp\wisp.exe` |
| INST-43 | marker files in `~/.wisp` and the profile stay; the new app on the bundled Node serves v0.57.0's task |
| INST-44 | v0.57.0 again, left running, then the installer with `/S /NS` (no links of its own, as an interactive install makes no desktop link unless asked): Electron stopped and gone, the hook alone moved its links |
| INST-45 | a link of the user's own that says wisp stays where it points; Tauri's uninstaller leaves `~/.wisp` |
| INST-46 | v0.57.0's own updater, in the running app started from its own folder as its Start menu shortcut does (only its release list stood in for): it downloads this installer, hands `/S --force-run` to its waiter and quits; the Tauri app comes up on 4477 on its bundled Node, Electron's folder gone, one entry, every link on Tauri |
