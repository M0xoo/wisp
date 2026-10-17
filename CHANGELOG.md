# Changelog

All notable changes to `wisp-agents` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The launcher stays reachable while you scroll: once it passes under the top bar it docks there as a one-line bar (project chip + draft). Click it, or press `⌘L` / `N`, and the full launcher opens in place over the feed, without scrolling you back to the top. `Esc` or clicking away folds it again.

## [0.7.0] - 2026-10-17

### Added

- Update button next to Search when a newer `wisp-agents` is on npm (checked at start, then once a day while wisp stays open — survives sleep, and the UI re-asks on focus). One click runs `npm install -g wisp-agents@latest` (or relaunches through `npx …@latest`) and restarts wisp; it asks first if agents are running. Git checkouts just get the `git pull` hint. Opt out with `WISP_UPDATE_CHECK=0`.
- Rerun a task: right-click a card → **Rerun…** (or `⇧R`, or ⌘K → Rerun). A dialog opens with the original prompt (editable), attachments and mode, plus the harness / model / thinking-level picker. You can pick a different setup without changing the launcher's defaults. Rerunning starts a new session in the same folder and keeps the original.
- Learning from sessions: after a session goes quiet (90 s, or right away when marked done or archived), a background retro (same harness, read-only, no tools; Haiku on Claude Code) records your preferences and the agent's lessons (a mistake and the way that worked), globally and per project. Later turns get them in their system prompt. Stored in `~/.wisp/preferences.json`; API `GET/PUT /api/preferences`. See [Learning](README.md#learning).
- Memory view (Settings → *Memory* → Open, or ⌘K → Memory): a tab per scope with preferences and lessons, the session that taught each item, a token estimate, and inline edit / add / forget. The *Retros* tab is a timeline of every retro run (last 30), including *nothing new* and failures with the reason, plus a live entry while one runs. Switching Memory off stops both learning and applying.

### Fixed

- The card you were reading stays in view after collapsing a section, and the open card is followed when it moves to another section.

## [0.6.0] - 2026-10-17

### Added

- Antigravity CLI adapter (`agy --input-format stream-json --output-format stream-json`). Plan → `--mode plan`, Edits → `--mode accept-edits`, Full auto → `--dangerously-skip-permissions`; models from `agy models`, `--effort low|medium|high`, follow-ups via `--conversation`. Like Cursor it has no flag to inject MCP servers, so Antigravity agents ask with a `question` block. Override the binary with `WISP_ANTIGRAVITY_BIN`.
- Integrations: wisp can now be driven by other agents, editors and scripts. Reference: [docs/integrations.md](docs/integrations.md).
- `wisp mcp`: a stdio MCP server with `wisp_launch`, `wisp_wait`, `wisp_get`, `wisp_reply`, `wisp_list`, `wisp_stop` and `wisp_agents`, so Claude Code, Codex, opencode, Cursor or Claude Desktop can hand tasks to wisp and read the results.
- Agent skill (`skills/wisp/SKILL.md`), installed with `wisp skill install [--agent claude|codex|opencode|all] [--project]`.
- Scripting CLI: `wisp ls`, `show`, `wait`, `reply`, `stop`, plus `--json`, `--wait`, `--cwd`, `--model` and `--effort` on launches. Use `wisp -- …` for a task whose first word is a command name.
- JS SDK: `import { WispClient } from 'wisp-agents'`. It connects to the running wisp (or starts a headless one) and covers launch, wait, reply, presentation, uploads and the event stream. `wisp-agents/render`, `/protocol` and `/server` are exported too.
- HTTP API: `GET /api/health`, `GET /api/openapi.json` (OpenAPI 3.1), `GET /api/sessions/:id/wait` (long-poll until it finishes or asks), `GET /api/sessions/:id/presentation` (blocks + markdown, `?format=markdown`), and `state`/`agent`/`project`/`cwd`/`archived`/`limit` filters on `GET /api/sessions`.
- `~/.wisp/server.json` advertises the running server's URL, port and pid.
- Webhooks (`PATCH /api/config {"webhooks": [...]}`): POST `session.finished` / `session.waiting` with the presentation as markdown.

### Fixed

- Clicking a harness in the harness · model picker (or Enter on it) switches to it with the model and thinking level shown, instead of only previewing its models.
- Antigravity models are listed with newer `agy` builds that print tab-separated `agy models` output.
- A harness CLI installed while wisp is running is detected without restarting wisp.

## [0.5.0] - 2026-10-17

### Added

- Anonymous usage stats and error reports via [PostHog](https://posthog.com): which agents, models and modes are used, run outcomes and timings, and errors (agent failures, server errors, crashes) with paths scrubbed. Never sends prompts, output, paths or project names. Turn it off in Settings → *Anonymous usage stats*, or with `WISP_TELEMETRY=0` / `DO_NOT_TRACK=1`; always off when `CI` is set. See the Telemetry section of the README.

## [0.4.0] - 2026-10-17

### Added

- Thinking level in the harness · model picker: Default / Low / Medium / High / X-High / Max under the model list, remembered per harness and shown on the launcher button. Claude Code gets `--effort`, Codex `-c model_reasoning_effort=…`, opencode `--variant` (levels read per model from `opencode models --verbose`). Cursor bakes effort into its model ids, so it has no separate selector.
- Take over in [cmux](https://cmux.dev): opens a new cmux workspace in the project running the resume command. Auto-detected when wisp is started from a cmux terminal.

## [0.3.0] - 2026-10-17

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
- Archive tasks: right-click a task (or press `A`) to archive it. Archived tasks move to a collapsed *Archived* section and keep their state; a new question or turn brings them back.
- Right-click menus on tasks (open, rename, mark done, archive, delete), project chips (remove) and queued follow-ups (cancel).
- `⌘L` / `Ctrl+L` focuses the launcher from anywhere. `M` renames the focused item. Menus show key hints.
- Queued follow-ups are listed above the composer and can be cancelled from an × button, with confirmation.
- Task cards and requests show the harness logo, with a "harness · model" tooltip.

### Fixed

- Image blocks pointing outside the project (e.g. `/tmp/shot.png`) no longer render broken.
- Replying to a finished agent no longer gets queued behind a CLI that keeps running after its result. A run now ends on exit, 3s after its result, or when a follow-up arrives.
- Removing a project or deleting a session no longer fails silently (body-less `DELETE`s now send a JSON content type).
- The notifications setting is a real on/off switch.
- Finished cards fold up unless you are looking at them.
- Shortcut labels read `⌘L` on macOS and `Ctrl+L` elsewhere, and modifier shortcuts work on non-Latin keyboard layouts.

### Changed

- A follow-up sent while an agent is working now goes out right away: wisp interrupts the run and resumes the session with your message. To get the old behaviour back (wait until the run finishes), turn on the **Queue** toggle next to the send button. It shows while the agent is working, and wisp remembers the choice.
- The Plan / Edits / Full auto control is now one compact button with a menu. It shows a label only for a non-default mode; `Shift+Tab` in the prompt cycles modes.
- The top bar no longer shows harness status; Settings lists each harness with its version.
- Slimmer scrollbars that don't shift the layout.

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

[Unreleased]: https://github.com/M0xoo/wisp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/M0xoo/wisp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/M0xoo/wisp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/M0xoo/wisp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/M0xoo/wisp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/M0xoo/wisp/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/M0xoo/wisp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/M0xoo/wisp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/M0xoo/wisp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/M0xoo/wisp/releases/tag/v0.1.0
