# Changelog

All notable changes to `wisp-agents` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Codex (`codex exec --json`), opencode (`opencode run --format json`) and Cursor CLI (`cursor-agent -p`) adapters, next to Claude Code. Pick the harness and model together in the launcher, or pass `--agent` on the CLI.
- One harness · model picker in the launcher: harnesses (with logos) on the left, that harness's models on the right, searchable and grouped by provider for opencode. The model is remembered per harness. opencode and Cursor model lists are read from the CLIs themselves.
- `ask_user` works in Codex and opencode (injected MCP server). Cursor has no flag to inject one, so Cursor agents ask with a `question` block instead.
- Diffs for harnesses that only report "file changed" are taken against the file as it was when the turn started (`git stash create`), or the agent's own before/after content when available.
- Windows: harness CLIs installed through npm (`.cmd` shims) and PowerShell-only installs now start. npm shims run as `node <script>`, so arguments reach the CLI unchanged. Stopping a run ends the whole process tree (`taskkill /T`).
- Take over on Windows (Windows Terminal, PowerShell, Command Prompt) and on more Linux terminals (GNOME Terminal, Konsole, Xfce Terminal, Alacritty, xterm). The settings list only shows terminals for your OS.
- Test suite (`npm test`) and CI on Linux, macOS, and Windows, plus `npm run test:real` to smoke-test the real CLIs.
- Images an agent shows are copied into `~/.wisp/shots/<session>/` when the turn finishes, so screenshots saved to `/tmp` survive reboots. Existing sessions are backfilled on startup if their files still exist. Deleting a session deletes its copies.
- Command palette (`⌘K` / `Ctrl+K`, or the Search button in the top bar): fuzzy search across sessions (title, project, summary, agent), project filters, global actions, and actions on the focused session.

### Fixed

- Image blocks pointing outside the project (e.g. `/tmp/shot.png`) no longer render broken.

### Changed

- A follow-up sent while an agent is working now goes out right away: wisp interrupts the run and resumes the session with your message. To get the old behaviour back (wait until the run finishes), turn on the **Queue** toggle next to the send button. It shows while the agent is working, and wisp remembers the choice.

## [0.2.2] - 2026-10-16

### Fixed

- Desktop app: sending a message no longer opens an extra wisp icon in the Dock. The `ask_user` helper now runs the Electron binary as plain Node (`ELECTRON_RUN_AS_NODE=1`) instead of starting a second app.

## [0.2.1] - 2026-10-16

### Added

- Desktop app: native right-click menu with spelling suggestions, Copy Link, undo/redo, cut/copy/paste and select all. Inspect Element appears only in dev mode.

### Fixed

- macOS: the Dock shows "wisp" with the wisp icon instead of "Electron". The app now launches from a renamed clone of `Electron.app`, cached per Electron version under `~/Library/Caches/wisp`.

## [0.2.0] - 2026-10-16

### Added

- `npx wisp-agents` opens the desktop app. Electron is now an optional dependency that is fetched on first launch. The CLI starts the app detached and falls back to the browser when Electron isn't available.
- `--browser` flag to keep the browser-only behaviour.

### Fixed

- Parsing of the `wisp` fence is more robust: malformed blocks are salvaged instead of dropped, and the raw turn text is kept.

## [0.1.0] - 2026-10-16

### Added

- First public release on npm as `wisp-agents`, with `wisp` and `wisp-agents` bins and a `--version` / `-v` flag.
- Launch Claude Code agents in the background and read the presentation they hand back: diffs, tests, commits, flows and questions.
- Session queue with follow-ups, answers to agent questions, terminal takeover and mark-as-done.
- Older turns are folded, with a floating collapse-all button and back-to-top.

[Unreleased]: https://github.com/M0xoo/wisp/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/M0xoo/wisp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/M0xoo/wisp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/M0xoo/wisp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/M0xoo/wisp/releases/tag/v0.1.0
