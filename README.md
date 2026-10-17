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
[![Harnesses](https://img.shields.io/badge/harness-Claude%20Code%20·%20Codex%20·%20opencode%20·%20Cursor%20·%20Antigravity-d97757)](#adding-a-harness)

[Quick start](#quick-start) · [Features](#features) · [CLI](#cli) · [Integrations](#integrations) · [Shortcuts](#keyboard-shortcuts) · [Architecture](#architecture) · [Adding a harness](#adding-a-harness) · [Roadmap](#roadmap)

</div>

---

## Why wisp?

Agent transcripts are long, and you rarely need them. wisp runs agent harnesses (Claude Code, Codex, opencode, Cursor, and Antigravity) on your projects in the background. When an agent finishes, it hands you a short, animated **presentation**: diffs, test results, commits, flows, and decisions. The session then waits in your queue.

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
| 📥 **A queue** | Sessions sort into *Needs you*, *Working* (with a live one-line status), and *Done*. Archive what you don't need to see. |
| 💬 **Follow-ups that interrupt** | A follow-up sent mid-run interrupts the agent and resumes it with your message. Turn on **Queue** to wait for the run to finish instead; queued messages can be cancelled. |
| 🔎 **Command palette** | `⌘K` / `Ctrl+K` fuzzy-searches sessions, projects, and actions. |
| 🤖 **Any harness** | Claude Code, Codex, opencode, Cursor CLI, or Antigravity CLI. Pick the harness, model and thinking level together in the launcher; both are remembered per harness. Each card shows the harness it ran on. |
| 🖥️ **Take over** | Opens your terminal with the harness's resume command (`claude --resume <id>`, `codex resume <id>`, …) in the project folder. Works with Terminal, iTerm, Ghostty, Warp, cmux, kitty, WezTerm, GNOME Terminal, Konsole, Alacritty, Windows Terminal, PowerShell, or a custom command. |
| 📎 **Attachments** | Paste screenshots or drop images, video, logs, or PDFs into the launcher. |
| 🔐 **Permission modes** | Choose **Plan** (read-only), **Edits** (file edits auto-accepted), or **Full auto** for each launch. `Shift+Tab` in the prompt cycles modes. |
| 🔌 **Integrations** | An MCP server (`wisp mcp`), an agent skill, a scriptable CLI, a JS SDK, an OpenAPI-described HTTP API, and webhooks. Hand tasks to wisp from Claude Code, Codex, opencode, Cursor, scripts or CI. |
| 🪶 **No runtime dependencies** | The server uses only Node built-ins. Electron is needed only for the desktop app. |

## Quick start

> **Requirements:** macOS, Linux, or Windows; Node.js ≥ 20; and at least one harness installed and signed in: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`), [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), or [Antigravity CLI](https://antigravity.google/docs/cli/headless/) (`agy`). Override a binary path with `WISP_CLAUDE_BIN`, `WISP_CODEX_BIN`, `WISP_OPENCODE_BIN`, `WISP_CURSOR_BIN`, or `WISP_ANTIGRAVITY_BIN`.

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
wisp --agent codex "add a test"   # harness: claude | codex | opencode | cursor | antigravity
```

Scripting (every command takes `--json`):

```sh
wisp "add a test" --wait          # block until it finishes, print the presentation as markdown
wisp ls --state running,waiting   # list sessions
wisp show <id>                    # state + latest presentation
wisp wait <id>                    # until it finishes or asks you something
wisp reply <id> "also do X"       # follow up (answers a pending question)
wisp stop <id>
wisp mcp                          # MCP server for other agents and editors
wisp skill install                # install the wisp skill for Claude Code (--agent all for Codex/opencode too)
```

| Option | Description |
|---|---|
| `--port`, `-p N` | Port to use (default `4477`, or `WISP_PORT`) |
| `--mode`, `-m` | `plan` · `edits` · `auto` |
| `--agent`, `-a` | `claude` · `codex` · `opencode` · `cursor` · `antigravity` (default: the agent last picked in the launcher) |
| `--model` · `--effort` | Model id and thinking level for the launch |
| `--cwd`, `-C DIR` | Project folder (default: the current one) |
| `--wait`, `-w` | Wait for the run to finish or ask, then print the presentation |
| `--json` | Machine-readable output |
| `--browser`, `-b` | Use the browser instead of the desktop app |
| `--no-open` | Just run the server; open nothing |
| `--version`, `-v` | Print the version |

> `npm install -g wisp-agents` (or `npm link` from a clone) puts `wisp` on your `PATH`. Without installing, use `npx wisp-agents …` with the same arguments.

## Integrations

wisp is a local server, and the app is just one client of it. Other agents, editors and scripts can launch tasks into the same queue and read the presentations back. Full reference: [docs/integrations.md](docs/integrations.md).

```sh
claude mcp add wisp -- npx -y wisp-agents mcp   # Claude Code can now delegate with wisp_launch / wisp_wait / wisp_reply
wisp skill install --agent all                  # teach Claude Code, Codex and opencode when and how to use wisp
```

```js
import { WispClient } from 'wisp-agents';
const wisp = await WispClient.connect();
const s = await wisp.launch({ prompt: 'fix the flaky auth test', cwd: '/path/to/repo' });
console.log((await wisp.wait(s.id)).state, (await wisp.presentation(s.id)).markdown);
```

- **MCP** (`wisp mcp`): `wisp_launch`, `wisp_wait`, `wisp_get`, `wisp_reply`, `wisp_list`, `wisp_stop`, `wisp_agents`. Config snippets for Claude Code, Codex, opencode, Cursor and Claude Desktop are in the docs.
- **Skill** ([`skills/wisp/SKILL.md`](skills/wisp/SKILL.md)): when to delegate, how to brief, and to pass a waiting agent's question on to you instead of answering it.
- **HTTP API**: `GET /api/openapi.json`. The new routes are `/api/health`, `/api/sessions/:id/wait` (long-poll), `/api/sessions/:id/presentation` (blocks + markdown), and filters on `/api/sessions`.
- **Discovery**: the running server writes `~/.wisp/server.json` (`url`, `port`, `pid`, `version`).
- **Webhooks**: `PATCH /api/config {"webhooks":[…]}`. wisp POSTs `session.finished` and `session.waiting` with the presentation as markdown.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘ K` / `Ctrl K` | Command palette: fuzzy-search sessions, projects and actions |
| `N` · `⌘ L` / `Ctrl L` | New task (focus the launcher; `⌘ L` works from anywhere) |
| `⇧ Tab` | Cycle permission mode (in the launcher) |
| `⌘ ↵` | Launch and keep the launcher open for the next task |
| `J` / `K` | Move down / up through the queue |
| `O` / `↵` | Open or collapse the focused session |
| `/` | Reply to the focused session |
| `1`–`9` | Pick an option in a pending question |
| `T` | Take over in your terminal |
| `E` | Mark done and jump to the next session that needs you |
| `A` | Archive / unarchive |
| `M` | Rename |
| `⌫` | Delete |
| `R` | Replay the presentation |
| `C` | Collapse all |
| `?` | Show all shortcuts |
| `Esc` | Close, blur, or collapse |

File paths in presentations open in your editor. VS Code, Cursor, Zed, and JetBrains IDEs are supported; pick one in **Settings**.

## Architecture

```text
web/ (UI) ⇄ HTTP + SSE ⇄ server/ ── adapters/claude.js   ── claude -p --output-format stream-json
                                 ├─ adapters/codex.js    ── codex exec --json
                                 ├─ adapters/opencode.js ── opencode run --format json
                                 ├─ adapters/cursor.js   ── cursor-agent -p --output-format stream-json
                                 ├─ adapters/antigravity.js ── agy --output-format stream-json
                                 └─ mcp-ask.js  (ask_user MCP tool, injected per run)
```

```text
wisp/
├── bin/
│   └── wisp.js            # CLI: starts the server or talks to the running one
├── server/
│   ├── index.js           # HTTP API, SSE stream, static UI, uploads
│   ├── openapi.js         # OpenAPI document for the public API
│   ├── client.js          # JS SDK (wisp-agents/client), used by the CLI and MCP server
│   ├── mcp-wisp.js        # `wisp mcp`: wisp as tools for other agents
│   ├── render.js          # presentation → markdown
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
│       ├── cursor.js      # Cursor CLI adapter
│       └── antigravity.js # Antigravity CLI adapter
├── skills/wisp/SKILL.md   # agent skill: how other agents use wisp
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
- **State** lives in `~/.wisp` (override with `WISP_HOME`): one JSON file per session, plus `config.json`, `uploads/`, and `shots/` (copies of images agents showed).

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
- [x] Antigravity CLI adapter

## Telemetry

wisp sends anonymous usage stats and error reports to [PostHog](https://posthog.com) so we can see which agents people use and what breaks. The code is in [`server/telemetry.js`](server/telemetry.js).

**What is sent:** a random install id (not tied to you or your machine), the wisp, OS, Node and agent CLI versions, and per run: agent, model, mode, effort, status, duration, token counts and cost, how many files changed, and which presentation block types came back. Errors include a stack trace and message with your home directory and file paths removed, cut to 500 characters.

**Never sent:** prompts, replies, agent output, file contents, project names, paths or repo URLs.

**Opt out** with any of these:
- Settings → *Anonymous usage stats*
- `WISP_TELEMETRY=0`
- `DO_NOT_TRACK=1`

It is also off whenever `CI` is set.

## Contributing

Issues and PRs are welcome. wisp has no build step: edit `web/` or `server/`, then run `npm run dev` (or `npm run dev:web`) to see your changes.

### Tests

```sh
npm test         # adapters, process launching, terminals, and the full ask_user loop
npm run test:real  # smoke test against the real CLIs installed on this machine
```

`npm test` needs no network or accounts. A fake CLI (`test/fixtures/fake-agent.mjs`) speaks each harness's real output format, edits files, and calls `ask_user` through the real MCP bridge. On Windows the fakes are installed as npm-style `.cmd` shims, which is how npm installs the real CLIs. CI (`.github/workflows/test.yml`) runs the suite on Linux, macOS, and Windows with Node 20 and 22, then runs `test:real` against freshly installed Claude Code, Codex, opencode, Cursor, and Antigravity CLIs.

## License

[MIT](LICENSE) © M0xoo
