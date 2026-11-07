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
| INST-16 self-update | Manual | Automated: the running app downloads a newer zip, swaps itself and reopens. Only the release list is stood in for |
| INST-20–22 Windows installer | Manual | CI (dry run): `/S` per user, `resources\app`, `node\node.exe`, `method: app`, `/S --force-run /R` starts it again |
| Linux AppImage, .deb | Manual | Stays on Electron until WebKitGTK can tell a frame from the page |
| INST-30 download links | Automated: names checked, each link answers | Same names: the same links |
| Gatekeeper on a browser download | Manual | Manual: Open Anyway on a real quarantined file, ad hoc signature |
| Site Download button, clicked | Manual | Manual |
| Electron→Tauri self-update | | Manual, needs a Tauri build on a release |

The Electron window (INST-03f, 05f) starts the binary `bin/wisp.js` would, with its own
`--user-data-dir`: Electron keeps that folder under the real home whatever `HOME` says, so bare `wisp`
would hit the lock of any wisp.app open on the Mac, quit and focus that one.

**Before the switch:** builds already out run `/S --force-run` on an update. Tauri's installer starts
the app on `/R` and ignores that, so a Windows user on such a build gets the update but no restart
until they open wisp. Only builds with `/S --force-run /R` restart on their own, so let one release
carry it before a Tauri build goes out. The two also install to different folders
(`%LOCALAPPDATA%\Programs\wisp` and `%LOCALAPPDATA%\wisp`): Electron's copy and its shortcuts stay
behind until something removes them.
