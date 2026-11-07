# Install gate

Every way into wisp, on real artefacts. Run `node desktop/scripts/package.mjs` (needs Rust), then
`node qa/install.mjs [--artefacts dist/tauri] [--only npm,script,brew,app,shell,links]`. It publishes
nothing: npm installs come from `npm pack`'s tarball into temp prefixes, `install.sh` reads a registry
and a release folder served by the script, HOME is a temp folder. A row with no artefact says *NOT
RUN*; it never passes. The table goes to `qa/out/install.md`. Every release, nightly and dry run
(`gh workflow run release --ref <branch> -f dry_run=true`) runs this on macOS, Windows and Linux in
`.github/workflows/tauri-package.yml`, on what it just built, before anything is published.

| Scenario | How |
|---|---|
| INST-01 `npm pack` | Automated: `electron/` stays off npm, and of `desktop/` only `entry.mjs` and `shell-path.js` are on it (what the shell runs under `WISP_ROOT`), with `bin/desktop-shell.js` |
| INST-02 `npm i -g` | Automated: no dependency installed; `--version`, `--no-open`, words, `--browser`, tab |
| INST-04 `npx` | Automated: wisp alone in `node_modules`; the same checks |
| INST-25 `npm i -g`, `wisp`: the shell alone | Automated (`shell`): `wisp-shell-<os>-<arch>.tar.gz` from a release served here (`WISP_SHELL_URL`), checked against SHA256SUMS.txt, into `$WISP_HOME/desktop/<version>/`; the server on this Node from the npm package, its parent the shell, `method: global`, no tab; on a Mac its window seen on screen (CGWindowList). Windows: the server, the window by hand |
| INST-26, 26b the next `wisp`, then kill -9 the shell | Automated: no download (the release is gone), no server left behind |
| INST-27 a shell that doesn't match its sum | Automated: a tab, and one line with the app's address; nothing kept |
| INST-28 no build for this platform (or offline) | Automated: the same tab and line |
| INST-06 `install.sh`, `WISP_VERSION=next` and `nightly` | Automated |
| INST-07 `install.sh` with no Node | Automated |
| INST-08, 09 Homebrew formula | Automated: read through, its steps run in a temp Cellar. A real `brew install`: Manual |
| INST-10 SHA256SUMS.txt | Automated: the same lines as release.yml |
| INST-11, 12 `install.sh --app` | Automated: no Node on PATH, Node's executable bit, a bad sum refused |
| INST-13 dmg | Automated: holds wisp.app and Applications, Node runs from the image |
| INST-14, 15 the app, direct and by `open -n` | Automated: server on the bundled Node, none on PATH, `method: app`, no orphan after kill -9 |
| INST-17 the app through a symlinked folder | Automated: Tauri refuses `resource_dir()` there, so the shell reads the real path |
| INST-15c as Finder starts it | Automated: launchd's PATH, no node, agents from the login shell |
| INST-16, 16b self-update | Automated: the running app downloads a newer zip, swaps itself and reopens. 16b is all inside the app: `POST /api/update`, its hand-off, the real `open`; only the release list is stood in for |
| INST-18 Electron→Tauri self-update | Automated with `--old-electron <zip>`: tauri-package.yml fetches v0.57.0's `wisp-mac-arm64.zip` |
| INST-19 the shell as Electron's helper | Automated: `ELECTRON_RUN_AS_NODE=1 wisp -p` is the bundled Node |
| INST-20–22, 24 Windows installer | CI: `/S` per user, `resources\app`, `node\node.exe`, `method: app`; `/S /R` (the app's own update) and `/S --force-run` (an Electron build already out) each start it again |
| INST-40–46 from Electron to Tauri on Windows | CI (`tauri-windows.yml`, `--only migrate`): a real v0.57.0, then this installer, and v0.57.0's own update onto it, below |
| INST-50–53 Linux .deb and AppImage | CI (x64 and arm64 under Xvfb): the .deb installs `/usr/bin/wisp` with wisp and Node in `/usr/lib/wisp`, WebKitGTK in Depends; its app is `method: app` with no download of its own; the AppImage starts on its own Node under its mount; and updates itself through `POST /api/update` |
| Linux .deb over a newer .deb, Electron's .deb (`wisp-agents`) replaced | Manual |
| INST-30 download links | Automated: names checked, each link answers |
| Gatekeeper on a browser download | Manual: Open Anyway on a real quarantined file, ad hoc signature |
| Site Download button, clicked | Manual |

INST-03 and INST-05 were `npm i -g` and `npx` with the `electron` optional dependency; INST-23 probed
electron-builder's own installer. No release makes either now.

**Builds of the Electron app already out** can't change, so this one answers them. On a Mac they
run their own binary as Node after the swap, and by then that's the Tauri shell: `macos::be_node_for_electron`
makes it Node for that one run. On Windows they run `/S --force-run`: Tauri's installer knows only `/R`,
and `desktop/src-tauri/installer-hooks.nsh` gives it the other word. The app's own update sends `/R`.
The two install to different folders, and the same hook takes Electron's copy away (INST-40–46 below,
INST-46 the whole update in v0.57.0's own code). The cmd.exe that update starts the installer from stands in
Electron's folder, so Windows keeps it until the installer is done: `desktop/remove-electron.mjs`, hidden on the
bundled Node, removes it then.

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
