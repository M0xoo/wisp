<div align="center">

<img src="electron/icon.png" alt="wisp" width="120" />

# wisp

**Send coding agents off. Read the highlights.**

Launch coding agents in the background, skip the transcript, and read the presentation they hand back when they finish.

[![npm](https://img.shields.io/npm/v/wisp-agents?color=cb3837&logo=npm)](https://www.npmjs.com/package/wisp-agents)
[![License: MIT](https://img.shields.io/badge/license-MIT-6a5cff.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848f?logo=electron&logoColor=white)](https://www.electronjs.org)
[![Zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![Harnesses](https://img.shields.io/badge/harness-Claude%20Code%20·%20Codex%20·%20opencode%20·%20Cursor-d97757)](#adding-a-harness)

[Quick start](#quick-start) · [Features](#features) · [CLI](#cli) · [Shortcuts](#keyboard-shortcuts) · [Architecture](#architecture) · [Adding a harness](#adding-a-harness) · [Roadmap](#roadmap)

</div>

---

## Why wisp?

Agent transcripts are long, and you rarely need them. wisp runs agent harnesses (Claude Code, Codex, opencode, and Cursor) on your projects in the background. When an agent finishes, it hands you a short, animated **presentation**: diffs, test results, commits, flows, and decisions. The session then waits in your queue.

From there you can **follow up**, **answer its questions**, **take it over** in your terminal, or **mark it done**.

```text
 you ──▶ "fix the flaky auth test" ──▶ agent works in the background
                                              │
 you ◀── hero · diff · tests · next steps ◀───┘   (no transcript to read)
```

## Features

| | |
|---|---|
| 🚀 **Fire and forget** | Launch a task from the UI or from any folder with `wisp "…"`. Each folder becomes a project. |
| 🎞️ **Presentations, not transcripts** | Agents end with structured blocks that render as an animated, skimmable report. |
| ❓ **Live questions** | Agents get an `ask_user` tool, so they can pause mid-run. Your answer goes straight back to the running agent. |
| 🧾 **Real diffs** | Edits come from the agent's own tool calls, so `diff` blocks show what actually changed. |
| 📥 **A queue** | Sessions sort into *Needs you*, *Working* (with a live one-line status), and *Done*. |
| 🤖 **Any harness** | Claude Code, Codex, opencode, or Cursor CLI. Pick one per launch next to the model. Models are discovered from each CLI. |
| 🖥️ **Take over** | Opens your terminal with the harness's resume command (`claude --resume <id>`, `codex resume <id>`, …) in the project folder. Works with Terminal, iTerm, Ghostty, Warp, kitty, WezTerm, or a custom command. |
| 📎 **Attachments** | Paste screenshots or drop images, video, logs, or PDFs into the launcher. |
| 🔐 **Permission modes** | Choose **Plan** (read-only), **Edits** (file edits auto-accepted), or **Full auto** for each launch. |
| 🪶 **No runtime dependencies** | The server uses only Node built-ins. Electron is needed only for the desktop app. |

## Quick start

> **Requirements:** macOS, Linux, or Windows; Node.js ≥ 20; and at least one harness installed and signed in: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`), or [Cursor CLI](https://cursor.com/cli) (`cursor-agent`). Override a binary path with `WISP_CLAUDE_BIN`, `WISP_CODEX_BIN`, `WISP_OPENCODE_BIN`, or `WISP_CURSOR_BIN`.

```sh
npx wisp-agents                          # open the wisp desktop app
npx wisp-agents "fix the flaky auth test" # launch a task in the current folder
npx wisp-agents --browser                # or use it in the browser → http://localhost:4477
```

The first run downloads Electron for the desktop app; if that isn't possible, wisp opens in the browser instead.

Or install it globally to get the `wisp` command everywhere:

```sh
npm install -g wisp-agents
wisp "fix the flaky auth test"
```

From source:

```sh
git clone https://github.com/M0xoo/wisp.git
cd wisp

# Browser mode, with nothing to install:
node bin/wisp.js           # → http://localhost:4477

# Desktop app:
npm install                # pulls Electron
npm run app
```

On first launch, the *Welcome to wisp* session shows a live gallery of every presentation block.

### Development

```sh
npm run dev        # desktop app: live reload for web/, relaunch on server/ and electron/ changes
npm run dev:web    # browser mode, restarts the server when server/ changes
```

## CLI

The CLI talks to a running wisp, or starts one if none is running. It works from any folder:

```sh
wisp                              # open wisp (or focus the running one)
wisp "fix the flaky auth test"    # launch a task in this folder (it becomes a project)
wisp add [path]                   # add a folder as a project (default: cwd)
wisp --mode plan "audit deps"     # permission mode: plan | edits | auto
wisp --agent codex "add a test"   # harness: claude | codex | opencode | cursor
```

| Option | Description |
|---|---|
| `--port`, `-p N` | Port to use (default `4477`, or `WISP_PORT`) |
| `--mode`, `-m` | `plan` · `edits` · `auto` |
| `--agent`, `-a` | `claude` · `codex` · `opencode` · `cursor` (default: the agent last picked in the launcher) |
| `--browser`, `-b` | Use the browser instead of the desktop app |
| `--no-open` | Just run the server; open nothing |
| `--version`, `-v` | Print the version |

> `npm install -g wisp-agents` (or `npm link` from a clone) puts `wisp` on your `PATH`. Without installing, use `npx wisp-agents …` with the same arguments.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘ K` / `Ctrl K` | Command palette: fuzzy-search sessions, projects and actions |
| `N` | New task (focus the launcher) |
| `⌘ ↵` | Launch and keep the launcher open for the next task |
| `J` / `K` | Move down / up through the queue |
| `O` / `↵` | Open or collapse the focused session |
| `/` | Reply to the focused session |
| `1`–`9` | Pick an option in a pending question |
| `T` | Take over in your terminal |
| `E` | Mark done and jump to the next session that needs you |
| `R` | Replay the presentation |
| `?` | Show all shortcuts |
| `Esc` | Close, blur, or collapse |

File paths in presentations open in your editor. VS Code, Cursor, Zed, and JetBrains IDEs are supported; pick one in **Settings**.

## Architecture

```text
web/ (UI) ⇄ HTTP + SSE ⇄ server/ ── adapters/claude.js   ── claude -p --output-format stream-json
                                 ├─ adapters/codex.js    ── codex exec --json
                                 ├─ adapters/opencode.js ── opencode run --format json
                                 ├─ adapters/cursor.js   ── cursor-agent -p --output-format stream-json
                                 └─ mcp-ask.js  (ask_user MCP tool, injected per run)
```

```text
wisp/
├── bin/
│   └── wisp.js            # CLI: starts the server or talks to the running one
├── server/
│   ├── index.js           # HTTP API, SSE stream, static UI, uploads
│   ├── runner.js          # session lifecycle, follow-ups, event normalization
│   ├── protocol.js        # system prompt + ```wisp block parser (markdown fallback)
│   ├── mcp-ask.js         # ask_user MCP server
│   ├── store.js           # JSON-file persistence in ~/.wisp
│   ├── terminal.js        # "take over" in your terminal
│   ├── welcome.js         # the gallery session
│   └── adapters/
│       ├── index.js       # adapter registry + contract
│       ├── common.js      # shared spawn/JSONL plumbing, labels, diff capture
│       ├── claude.js      # Claude Code adapter
│       ├── codex.js       # Codex CLI adapter
│       ├── opencode.js    # opencode adapter
│       └── cursor.js      # Cursor CLI adapter
├── web/                   # vanilla JS UI, no build step
│   ├── index.html
│   ├── css/app.css
│   └── js/{app,blocks,diff,md}.js
└── electron/              # desktop shell
    ├── main.js
    └── preload.cjs
```

- **Protocol** (`server/protocol.js`): a system prompt tells agents to work autonomously and to end with a fenced `wisp` JSON block of presentation blocks. The parser reads that block, and falls back to plain markdown if it is missing.
- **Adapters** (`server/adapters/`): one file per harness. An adapter turns a run into normalized events (`session`, `tool`, `change`, `text`, `result`, …) and provides a `resumeCommand` for take over.
- **State** lives in `~/.wisp` (override with `WISP_HOME`): one JSON file per session, plus `config.json` and `uploads/`.

### Presentation blocks

`hero` · `markdown` · `steps` · `stats` · `files` · `tree` · `diff` · `code` · `tests` · `commits` · `terminal` · `compare` · `flow` · `chart` · `checklist` · `callout` · `image` · `question` · `next`

## Adding a harness

1. Copy `server/adapters/claude.js`.
2. Implement `detect()`, `run()`, and `resumeCommand()`. The full contract is documented at the top of `server/adapters/index.js`.
3. Register the adapter in `server/adapters/index.js`.

If the harness has no system-prompt flag, prepend `systemPrompt` to the first prompt (`withProtocol` in `common.js`). If it supports MCP, pass `mcpServers` through so that `ask_user` works and set `askTool` to the name the agent sees; set `askTool: null` if it can't, and agents will ask with a `question` block instead.

## Roadmap

- [x] Claude Code adapter
- [x] Live `ask_user` questions
- [x] Desktop app (Electron)
- [x] Codex adapter
- [x] opencode adapter
- [x] Cursor CLI adapter

## Contributing

Issues and PRs are welcome. wisp has no build step: edit `web/` or `server/`, then run `npm run dev` (or `npm run dev:web`) to see your changes.

### Tests

```sh
npm test         # adapters, process launching, terminals, and the full ask_user loop
npm run test:real  # smoke test against the real CLIs installed on this machine
```

`npm test` needs no network or accounts. A fake CLI (`test/fixtures/fake-agent.mjs`) speaks each harness's real output format, edits files, and calls `ask_user` through the real MCP bridge. On Windows the fakes are installed as npm-style `.cmd` shims, which is how npm installs the real CLIs. CI (`.github/workflows/test.yml`) runs the suite on Linux, macOS, and Windows with Node 20 and 22, then runs `test:real` against freshly installed Claude Code, Codex, opencode, and Cursor CLIs.

## License

[MIT](LICENSE) © M0xoo
