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
[![Harnesses](https://img.shields.io/badge/harness-Claude%20Code%20·%20Codex%20·%20opencode%20·%20Cursor%20·%20Antigravity%20·%20Grok-d97757)](#adding-a-harness)

[Website](https://trywisp.dev/) · [Quick start](#quick-start) · [Features](#features) · [CLI](#cli) · [Integrations](#integrations) · [Shortcuts](#keyboard-shortcuts) · [Architecture](#architecture) · [Adding a harness](#adding-a-harness) · [Roadmap](#roadmap)

</div>

---

## Why wisp?

Agent transcripts are long, and you rarely need them. wisp runs agent harnesses (Claude Code, Codex, opencode, Cursor, Antigravity, and Grok) on your projects in the background. When an agent finishes, it hands you a short, animated **presentation**: diffs, test results, commits, flows, and decisions. The session then waits in your queue.

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
| 📜 **The full transcript, if you want it** | Off by default. Settings → General → *Full transcript*, or a card's **Transcript** button (`V`), shows the agent's messages and every step on a timeline. Click a step to see its output or diff. The presentation still renders as blocks at the end. |
| ❓ **Live questions** | Agents get an `ask_user` tool, so they can pause mid-run. Your answer goes straight back to the running agent. |
| 🧾 **Real diffs** | Edits come from the agent's own tool calls, so `diff` blocks show what actually changed. |
| 📥 **A queue** | Sessions sort into *Needs you*, *Working* (with a live one-line status), and *Done*. Archive what you don't need to see. |
| 💬 **Follow-ups that interrupt** | A follow-up sent mid-run interrupts the agent and resumes it with your message. Turn on **Queue** to wait for the run to finish instead; queued messages can be cancelled. To ask without interrupting, start with `/btw` (`/btw did you update the docs too?`): a separate read-only run answers on a copy of the conversation, and the agent keeps working. |
| 🔎 **Command palette** | `⌘K` / `Ctrl+K` fuzzy-searches sessions, projects, and actions. |
| ✨ **Auto** | The default harness: wisp picks the harness, model and thinking level per task from what worked before, and learns from merges, 👍 / 👎 and follow-ups. See [Auto](#auto). |
| 🤖 **Any harness** | Claude Code, Codex, opencode, Cursor CLI, Antigravity CLI, or Grok Build. Pick the harness, model and thinking level together in the launcher; both are remembered per harness. Each card shows the harness it ran on. |
| 🖥️ **Take over** | Opens your terminal with the harness's resume command (`claude --resume <id>`, `codex resume <id>`, …) in the project folder. Works with Terminal, iTerm, Ghostty, Warp, cmux, kitty, WezTerm, GNOME Terminal, Konsole, Alacritty, Windows Terminal, PowerShell, or a custom command. |
| 📎 **Attachments** | Paste screenshots or drop images, video, logs, or PDFs into the launcher. |
| 🧠 **Learns as you go** | After a session goes quiet, a background retro records your preferences and the agent's lessons (a mistake and the way that worked), globally and per project. Later runs get them in their prompt. See [Learning](#learning). |
| 🗂️ **One task, several folders** | ⌘-click a second project in the launcher (or its **+**) and one agent works in both, e.g. the API and the web app that uses it. Each git repo gets its own worktree, and **Ship it** opens a PR in each. |
| 🌿 **A worktree per task** | In a git repo each task gets its own worktree and branch from `origin/main`, so parallel agents never collide. |
| 🚢 **Ship it** | One click commits, pushes and opens the PR. The card follows CI and reviews; **Merge** squash-merges and syncs your local main. |
| 🤝 **Subagents** | Give the lead agent a team on other harnesses (e.g. Claude Code hands tests to Codex ×3). It delegates through a `delegate` tool; their edits land in its worktree. See [Subagents](#subagents). |
| ⏪ **Checkpoints & rollback** | Every turn is snapshotted first. Restore to before any turn, revert a single file, or re-run a command block from the presentation. |
| ⚖️ **Compare** | Run one task on two harnesses side by side, and keep the better run. |
| ✨ **Spells** | Change wisp itself while it runs: ask for a floating button that opens your PRs, a panel with your tool stats, a block agents can use in their reports, a different prompt box, quick replies, buttons on cards, a new look. An agent writes it as a *spell*; you try it in the window and keep it. Share one as a file, and turn any of them off to put wisp back as it was. See [Spells](#spells). |
| 🧾 **Recipes & triggers** | Saved prompts with `{params}` (`wisp run release 0.24.1`), run by hand, on a schedule, when CI fails, or when an issue is labelled. |
| 📊 **Usage** | Spend, success rate and questions per project and per harness · model. |
| 📱 **Phone** | Questions and finished tasks on ntfy or Telegram; answer from there, or start a task with `/new`. |
| 🔐 **Permission modes** | Choose **Plan** (read-only), **Edits** (file edits auto-accepted), or **Full auto** (no permission prompts, the default) for each launch. `Shift+Tab` in the prompt cycles modes. In Edits mode, anything the permissions block comes to you: Claude Code waits for **Allow / Always / Deny**, and the other harnesses show an **Allow & retry** card. |
| 🔌 **Integrations** | An MCP server (`wisp mcp`), an agent skill, a scriptable CLI, a JS SDK, an OpenAPI-described HTTP API, and webhooks. Hand tasks to wisp from Claude Code, Codex, opencode, Cursor, scripts or CI. |
| 🪶 **No runtime dependencies** | The server uses only Node built-ins. Electron is needed only for the desktop app. |

## Quick start

> **Requirements:** macOS, Linux, or Windows; Node.js ≥ 20; and at least one harness installed and signed in: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`), [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), [Antigravity CLI](https://antigravity.google/docs/cli/headless/) (`agy`), or [Grok Build](https://x.ai/cli) (`grok`). No CLI? The [ChatGPT desktop app](https://chatgpt.com/download) is enough for Codex on macOS and Linux, and the [Claude desktop app](https://claude.com/download) for Claude Code on macOS and Windows once you've opened its Code tab and signed that CLI in once: wisp uses the CLI each app ships when the command isn't on PATH. Override a binary path with `WISP_CLAUDE_BIN`, `WISP_CODEX_BIN`, `WISP_OPENCODE_BIN`, `WISP_CURSOR_BIN`, or `WISP_ANTIGRAVITY_BIN`.

```sh
npx wisp-agents                          # open the wisp desktop app
npx wisp-agents "fix the flaky auth test" # launch a task in the current folder
npx wisp-agents --browser                # or use it in the browser → http://localhost:4477
```

The first run downloads Electron for the desktop app; if that isn't possible, wisp opens in the browser instead.

Or install it globally to get the `wisp` command everywhere. Pick one:

```sh
curl -fsSL https://trywisp.dev/install.sh | bash   # macOS or Linux: checks Node 20+, then npm install -g wisp-agents
npm install -g wisp-agents                      # any OS with Node 20+
brew install m0xoo/tap/wisp-agents             # Homebrew: CLI and browser mode, no Electron desktop app

wisp "fix the flaky auth test"
```

The Homebrew formula lives in [M0xoo/homebrew-tap](https://github.com/M0xoo/homebrew-tap). `install.sh` honors `WISP_VERSION` to pin a release (`curl -fsSL https://trywisp.dev/install.sh | WISP_VERSION=0.24.1 bash`).

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
wisp add <repo-url>               # clone a repo (GitHub URL, git@…, any git URL) into ~/code, then add it
wisp --mode plan "audit deps"     # permission mode: plan | edits | auto
wisp --agent codex "add a test"   # harness: claude | codex | opencode | cursor | antigravity | grok
```

Scripting (every command takes `--json`):

```sh
wisp "add a test" --wait          # block until it finishes, print the presentation as markdown
wisp ls --state running,waiting   # list sessions
wisp show <id>                    # state + latest presentation
wisp wait <id>                    # until it finishes or asks you something
wisp reply <id> "also do X"       # follow up (answers a pending question; --mode, --agent, --model to switch)
wisp btw <id> "did you do X?"     # ask on the side without interrupting the run; prints the answer
wisp stop <id>
wisp ship <id> [--draft]          # commit, push and open a PR for a worktree task
wisp merge <id>                   # squash-merge its PR, fast-forward your local main
wisp run release 0.24.1            # run a recipe; values fill its {params} (or version=0.24.1)
wisp recipes                      # list recipes
wisp usage [--days 7]             # spend and outcomes
wisp mcp                          # MCP server for other agents and editors
wisp skill install                # install the wisp skill for Claude Code (--agent all for Codex/opencode too)
```

| Option | Description |
|---|---|
| `--port`, `-p N` | Port to use (default `4477`, or `WISP_PORT`) |
| `--mode`, `-m` | `plan` · `edits` · `auto` |
| `--agent`, `-a` | `claude` · `codex` · `opencode` · `cursor` · `antigravity` · `grok` (default: the agent last picked in the launcher) |
| `--model` · `--effort` | Model id and thinking level for the launch |
| `--cwd`, `-C DIR` | Project folder (default: the current one) |
| `--also DIR` | Another folder the same task works in; repeat for more (each git repo gets its own worktree and PR) |
| `--wait`, `-w` | Wait for the run to finish or ask, then print the presentation |
| `--no-worktree` | Edit the folder in place instead of a fresh worktree (default in git repos: a worktree) |
| `--compare a[:model],…` | Also run the task on these harnesses, each in its own worktree |
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
| `S` | Ship it: commit, push and open a PR (worktree tasks) |
| `⇧ R` | Rerun with another harness, model or thinking level |
| `E` | Mark done and jump to the next session that needs you |
| `A` | Archive / unarchive |
| `M` | Rename |
| `⌫` | Delete |
| `R` | Replay the presentation |
| `V` | Switch between the full transcript and the presentation |
| `C` | Collapse all |
| `U` | Back to top (also `Home`) |
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
                                 ├─ adapters/grok.js     ── grok --output-format streaming-messages-json
                                 └─ mcp-ask.js  (ask_user MCP tool, injected per run)
```

```text
wisp/
├── bin/
│   └── wisp.js            # CLI: starts the server or talks to the running one
├── server/
│   ├── index.js           # startServer: wires the pieces below together
│   ├── http/              # route table, JSON responses + SSE, static UI
│   ├── routes/            # one file per API area: sessions, ship, settings, automations, machines, …
│   ├── services/          # shared by routes and background jobs: launch, ship, auto, uploads, phone, …
│   ├── util.js            # small shared helpers (errors, ids, quoting, atomic JSON writes)
│   ├── openapi.js         # OpenAPI document for the public API (test/routes.test.js keeps it in sync)
│   ├── client.js          # JS SDK (wisp-agents/client), used by the CLI and MCP server
│   ├── mcp-wisp.js        # `wisp mcp`: wisp as tools for other agents
│   ├── render.js          # presentation → markdown
│   ├── runner.js          # session lifecycle, follow-ups, event normalization
│   ├── checkpoint.js      # per-turn git checkpoints, file revert, rollback
│   ├── proc.js            # cross-platform spawn, and running a block's command
│   ├── protocol.js        # system prompt + ```wisp block parser (markdown fallback)
│   ├── mcp-ask.js         # ask_user MCP server
│   ├── store.js           # JSON-file persistence in ~/.wisp
│   ├── git.js             # worktrees, Ship it, PR status and merge (git + gh)
│   ├── recipes.js         # saved prompts with {params}
│   ├── triggers.js        # cron schedules and GitHub watchers
│   ├── remote.js          # phone: ntfy and Telegram, out and back
│   ├── machines.js        # other computers: SSH, a tunnel to wisp there, relayed sessions
│   ├── machines/          # known hosts (ssh config, Tailscale) and the bootstrap script
│   ├── usage.js           # spend and outcomes
│   ├── terminal.js        # "take over" in your terminal
│   ├── welcome.js         # the gallery session
│   └── adapters/
│       ├── index.js       # adapter registry + contract
│       ├── common.js      # shared spawn/JSONL plumbing, labels, diff capture
│       ├── claude.js      # Claude Code adapter
│       ├── codex.js       # Codex CLI adapter
│       ├── opencode.js    # opencode adapter
│       ├── cursor.js      # Cursor CLI adapter
│       ├── antigravity.js # Antigravity CLI adapter
│       └── grok.js        # Grok Build adapter
├── skills/wisp/SKILL.md   # agent skill: how other agents use wisp
├── web/                   # vanilla JS UI, native ES modules, no build step
│   ├── index.html
│   ├── css/               # one stylesheet per area (tokens, base, feed, blocks, modals, …), linked in order
│   └── js/
│       ├── app.js         # boot, top bar, routing
│       ├── core/          # state, api, event bus, DOM helpers
│       ├── ui/            # toasts, dialogs, popovers, keyboard hints
│       ├── features/      # feed, turns, composer, launcher, settings, ship, machines, …
│       └── {blocks,md,diff,fuzzy,palette}.js   # presentation blocks and their helpers
└── electron/              # desktop shell
    ├── main.js
    └── preload.cjs
```

- **Protocol** (`server/protocol.js`): a system prompt tells agents to work autonomously and to end with a fenced `wisp` JSON block of presentation blocks. The parser reads that block, and falls back to plain markdown if it is missing.
- **Adapters** (`server/adapters/`): one file per harness. An adapter turns a run into normalized events (`session`, `tool`, `change`, `text`, `result`, …) and provides a `resumeCommand` for take over.
- **State** lives in `~/.wisp` (override with `WISP_HOME`): one JSON file per session, plus `config.json`, `uploads/`, and `shots/` (copies of images agents showed).

### Presentation blocks

`hero` · `markdown` · `steps` · `stats` · `files` · `tree` · `diff` · `code` · `tests` · `commits` · `graph` · `terminal` · `compare` · `flow` · `chart` · `checklist` · `callout` · `image` · `question` · `actions` · `next`

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
- [x] Grok Build adapter

## Auto

**Auto** is the default harness: wisp picks the harness, model and thinking level for each task. Its "model" is a goal: **Balanced** (the default), **Cheap** or **Best**. Balanced and Best both run frontier models (Opus, not Sonnet or Haiku) when you have one installed and allowed; what sets them apart is how hard the agent thinks: Balanced runs at the harness's default or medium, Best at high or x-high. Cheap runs at low (or minimal) on whichever model does the job for least. A harness or model without levels runs at its default; for models with the level in their name (Antigravity's `gemini-4-argon-high`) the goal picks the variant the same way.

How it picks: every harness · model · thinking level you have installed is an option (`claude:opus:high`). For the kind of task (bug, feature, UI, tests, refactor, docs, release, question) Auto keeps an estimate of how often each option does it well. The estimate starts from a small wisp-bench pilot that ships with wisp (`server/router-priors.json`), then counts your own outcomes: merged PR (best), closed PR, 👍 / 👎, rollback, then how the run ended, less a bit for each follow-up you needed. It draws from each estimate (Thompson sampling), so options with little data now and then get a turn, and takes the best value for the goal after expected cost and time. A launch with `important: true` (API, SDK) gets the best-known option, with no trying. Options that keep failing a kind of task are left out of it. Thinking harder starts out a little more likely to work and costs more, and then your outcomes decide. A model's record at one level counts half at its other levels.

New harnesses and models: when a CLI or model shows up (after an install or a Re-check), it's on probation. It only gets the occasional exploring slot until it has three outcomes, and a new version (say a new Sonnet) starts from its family's record. **Settings → Auto** turns trying new models off, limits which harnesses Auto may use, and shows what it learned; **Forget** clears it.

Compare runs get different picks. A subagent set to Auto is picked on its first task and keeps that harness. A launch on a machine is picked here, from the harnesses that machine reported, and that machine's outcomes come back to the same router. All of it stays in `~/.wisp/router.json`; usage stats only add which goal, kind of task and size were used, and whether the pick was exploring.

After the run, Auto checks the work before it lands in your queue:

1. **Scout** (bigger tasks): a cheap model looks around the repo, read-only, and the agent gets the files that matter and the test command.
2. **Check**: wisp runs the project's tests itself. A failure only counts if that test passed on the base commit, and a failing suite runs twice so a flaky test doesn't count. The turn gets a **Run by wisp** tests block. If the agent said "done" and the run disagrees, the turn says so.
3. **Repair**: new failures go back to the same agent (1 round by default, up to 2).
4. **Hand over**: still failing, or the run errored, so the task runs again on a stronger tier (small → everyday → frontier) in its own worktree, next to the first run.

A harness that says it's at its limit (session or usage limit, rate limit, no credit) isn't failing the task. Auto rests it until the limit resets, doesn't count the run against it, and moves the task to the best pick that can run now. Best always runs frontier models only; it falls back to the strongest you have only when no frontier model is installed. Balanced runs on the strongest tier that can run now, whatever the record of the weaker models: frontier, or everyday (Sonnet, never Haiku) while every frontier model is at its limit or when you have none. The shipped estimates come from a small pilot, so they count for at most 4 tasks each.
5. **Best of two** (goal Best, off by default): two picks work side by side; tests decide, then a cheap model reads both diffs, and the better run is marked **Pick**.

Each step's outcome feeds the router: a test pass counts more than the agent's "done", needing a repair counts less, and losing a best-of-2 a little less again. Your own follow-up stops whatever Auto was about to do next. A launch on a machine is checked on that machine, where the files are. Settings → Auto turns each step on or off and sets the test command per project.

The benchmark behind the priors is in [`bench/`](bench/README.md).

## Worktrees and shipping

In a git repo, every launch (except Plan mode) runs in its own [git worktree](https://git-scm.com/docs/git-worktree) under `~/.wisp/worktrees/`, on a branch named `wisp/<task>-<id>` made from the remote's default branch (`origin/main`, fetched first; `HEAD` when there is no remote). Uncommitted changes in your own checkout are not carried over, and dependencies aren't shared: the agent is told to install what it needs. The card shows the branch, and **Take over** opens the worktree.

**Ship it** (`S`) commits whatever is uncommitted (the message is drafted from the presentation as a conventional commit; edit it before shipping), pushes the branch and runs `gh pr create`. You need the [GitHub CLI](https://cli.github.com) signed in. From then on the card follows the PR every minute: checks (✓ / running / failing), the review decision, merged or closed. **Merge** runs `gh pr ready` for drafts and `gh pr merge --squash --match-head-commit <sha>`, so a branch that moved since you looked is never merged, then fast-forwards your local base branch (`git merge --ff-only`, or a ref update when it isn't checked out) and removes the worktree and branch. If a ruleset requires a review, Merge waits for the approval like `gh` does.

**Compare** (the **vs** button next to the harness picker) launches the same task on a second harness. Both get their own worktree and show up as one task in the feed, with a row per run; **Compare** on the task shows them side by side, and **Keep this** archives the others and deletes their worktrees.

**Several folders.** A task can span projects: ⌘/Ctrl-click (or Shift-click) another project chip in the launcher, or use the **+** on its corner or in the project list. The agent starts in the first folder and gets the others as extra working directories (`--add-dir` for Claude Code and Codex; the rest are told the paths). Each git repo gets its own worktree on the task's branch name, the card reads `api + web` and lists under either project's filter, and **Ship it** commits, pushes and opens a PR per repo with changes, each noting the others. **Merge all** squash-merges them in order and syncs each local base branch. From the CLI or API: `wisp "…" --also ~/code/web`, `"also": ["~/code/web"]` on `POST /sessions`, or `also` on the `wisp_launch` MCP tool. wisp fixes merge conflicts only on the first repo's PR, and checkpoints and rollback cover the first folder.

Turn worktrees off in Settings → *Worktree per task*, with the launcher's **Worktree / In place** toggle, or per launch (`--no-worktree`, `"worktree": false`).

## Subagents

The launcher's **Subagents** button gives the lead agent a team: up to 6 members, each with its own harness, model, thinking level, name, a **Use for** note that tells the lead when to pick it, and a **×N** copies count (`Codex ×3` → `codex#1`…`codex#3`). The lead gets a `delegate` tool on wisp's MCP server; tasks sent in one call run in parallel in the lead's folder, and delegating to the same member again resumes its conversation. Claude Code, Codex, opencode and Grok can lead; Cursor and Antigravity can be members. **Save as preset** stores a team for later. Subagent edits count as the lead's, so they show up in its diffs, rollback and Ship it. API: `subagents` / `preset` on `POST /sessions`, `/teams`.

## Checkpoints and rollback

Before each turn, wisp snapshots the git working tree (pinned at `refs/wisp/checkpoints/<session>/<turn>`). **Restore to before this turn** (the ⏪ icon in the turn bar, session menu or ⌘K) rolls back; **Re-apply** undoes that. `diff` and `files` blocks have a per-file **Revert / Re-apply**, and `actions`, `terminal` and `tests` blocks run their command in the project folder with one click.

## Automations

**Recipes** are prompts you send again and again. `{name}` in a recipe becomes a field you fill in when it runs:

```text
Prepare release {version}: update CHANGELOG, README and docs/, bump package.json, tag v{version}.
```

Make one from ⌘K → *Recipes*, or *Save as recipe…* on any card. A recipe may pin a project, harness, model and mode. Run it from ⌘K (*Run: Release*), from the Recipes view, or from a terminal: `wisp run release 0.24.1` fills the fields in order, `wisp run release version=0.24.1` by name.

**Triggers** launch sessions on their own while wisp is open (⌘K → *Triggers*):

| Kind | Fires when | Prompt fields |
|---|---|---|
| Schedule | a cron expression matches (local time), e.g. `0 9 * * 1-5` | your recipe's fields |
| CI failed | a GitHub Actions run fails (optionally on one branch) | `{name} {branch} {url} {id} {sha}` |
| Issue labelled | an open issue carries a label | `{number} {title} {body} {url} {author}` |

GitHub triggers poll with your `gh` login (every 2–60 minutes), so nothing has to reach your machine; the first check only records what already exists. Issue triggers start in Plan mode: issue text comes from whoever can open issues, so think twice before giving it Full auto.

## Spells

A spell is a change to wisp that wisp layers over itself at runtime, without anyone editing its code: buttons, panels, blocks agents can use, a different look, how agents behave. Each is one JSON file in `~/.wisp/spells/`. Turning one off puts back exactly what it changed, and the file is all you need to share it.

**Cast one.** ⌘K → *Cast a spell…*, Settings → Spells, or `/spell …` in the prompt box. Say what you want:

```text
/spell a floating button that opens all my open PRs on GitHub, with how many there are
/spell a top bar button with my wisp tool stats for the last 30 days
/spell a "deploy" block agents can use to show where they deployed and whether it's healthy
/spell compact cards, the PR first, and an Open PR button on cards that have one
/spell quick replies above the follow-up box: Run the tests, Explain why…
/spell when a task finishes with failing tests, send it back once
```

An agent (in an empty folder of its own) reads the spell reference, samples the real data, checks the spell with wisp and hands it back as a card with a live preview: the buttons as they will look, panels drawn with your data, and what the spell does in plain words. **Try it** applies it to this window only (**Undo** takes it back); **Keep** turns it on. Ask a follow-up to change it, or "remove the … spell" to drop it.

**What a spell can do**

| | |
|---|---|
| Add | Buttons in the top bar, floating in a corner (grouped into a menu), in the prompt box and the follow-up box, on cards (on hover, in the head, in the menu) and in ⌘K. Chips and quick replies. Panels as a dialog, a drawer, above the feed or inside each card. |
| Change | Restyle or hide named parts (`card.title`, `launcher.compare`, `topbar.machines`, …), reorder a card's head, set the prompt box's placeholder, rows and font, recolour wisp (`--accent`, …). |
| Agents | New block types for reports (`deploy`, …), rules added to agents' prompts (all or per project / harness), `/commands`, settings while the spell is on. |
| On its own | Hooks: when a turn finishes or fails, a task starts or waits for you, reply once, mark done, archive, notify or POST to a URL. |
| Data | Read-only wisp routes (`/sessions`, `/usage/tools`, …) and read-only `gh` commands (`search prs`, `pr checks`, `run list`, …). wisp fetches them; spell code never touches the network. |

A spell's code (`script`) runs only in a sandboxed frame with no network, no DOM and no wisp API: it gets the data wisp fetched and returns values or blocks, which wisp checks and draws with its own renderer. Every spell shows how far it reaches: **Safe**, **Acts for you** (follow-ups, launches; only when you click, or a hook), **Reads GitHub**, or **Runs commands**. Questions, approvals and Settings → Spells can't be restyled or hidden. Start wisp with `WISP_SAFE=1` to turn every spell off, or use **Turn every spell off** in Settings → Spells.

**Share one.** Settings → Spells → export (a `.spell.json` file) or copy (JSON for a chat). Your colleague drops the file on wisp, pastes it or a link (https or `gist:<id>`) into Settings → Spells, or runs `wisp spell install ./my-prs.spell.json`. They see the same review before anything changes, and it stays off until they turn it on.

```sh
wisp spell                         # list: ● on  ○ off
wisp spell cast "a /explain command that asks for a plain-words explanation"
wisp spell install my-prs.spell.json --on
wisp spell export my-prs > my-prs.spell.json
wisp spell off --all
```

## Usage

⌘K → *Usage* shows spend per day and, per project and per harness · model: spend, turns, how often the run worked (finished, not partial or blocked), how often the agent had to ask you, and the average time. Claude Code, opencode and Grok report cost (Grok only when its plan does); Codex, Cursor and Antigravity only report tokens, so their turns are counted but not priced. Also `wisp usage` and `GET /api/usage?days=30`.

## Phone

Settings → *Phone* sends questions and finished tasks to your phone and takes the answers back. wisp polls both services, so it works from anywhere without opening a port.

- **[ntfy](https://ntfy.sh)**: subscribe to the topic in the ntfy app. Notifications carry up to three buttons (the question's options, or *Mark done*); a tap sends a signed answer back. Use a long random topic (wisp suggests one): anyone who knows it can read the notifications, but only wisp can make answers that count.
- **Telegram**: create a bot with @BotFather, paste its token, then send `/link <code>` to the bot. Tap a button to answer, or reply to a message to answer in your own words or send a follow-up.
  Switch on **Start tasks from Telegram** to launch from the chat: `/new <task>` runs in the default project (the last used, or the one you pick), `/new @project <task>` picks one by name and `/projects` lists them. Tasks use the launcher's harness, model and mode. It's off by default, and only the linked chat can start tasks.

They receive titles, summaries and questions (with their context), never code or diffs.

## Machines

**Machines** (top bar, Settings → *Machines*, or ⌘K) runs agents on your other computers over SSH. Give it `user@host` or a `Host` from `~/.ssh/config` and press **Connect**:

1. wisp signs in with `ssh` using your keys, agent and config (never a password; `BatchMode=yes`, new host keys are trusted on first use).
2. On the machine it finds Node.js 20+ and starts `npx -y wisp-agents@<this version> --no-open` detached, or reuses the wisp already answering on its port (4477 by default).
3. It forwards a free local port to that wisp with `ssh -L` and relays its event stream.

Every project runs on every machine. In the launcher, **Run on** (next to the harness) picks where the prompt goes: this computer, any machine, or several at once. A machine without a checkout of the project gets one first: wisp reuses a clone of the same repo it finds there, or clones the project's origin (repos without a remote can't be cloned; add their folder on the machine in Projects instead). Enter launches on every place in parallel, and the runs land as one task with a row per machine. Each run executes on its machine, with worktrees, diffs, rollback, `ask_user`, subagents, compare and Ship it all working on that machine. Its sessions join your feed with a badge, answer from your phone like any other, open in VS Code, Cursor or Windsurf through Remote - SSH, and **Take over** opens `ssh -t <host>` resuming the agent in your terminal.

Nothing new listens on the network: wisp on the machine stays on its own `127.0.0.1`, and it keeps running (agents too) when this computer sleeps or disconnects; wisp reconnects on its own. **Stop wisp there** (the machine's ⋯ menu) stops it. When the machine runs an older wisp than this computer, **Update to X** next to its version restarts it there as this version. The machine needs Node.js 20+ and the harness CLIs, signed in. Sessions there are `<id>@<machine>` in the API, CLI, SDK and MCP; recipes and schedules work with machine projects, while CI and issue triggers, usage and memory stay per machine.

A task can change computers mid-way: the **Runs on** button next to the composer moves your next follow-up (and the task) to another computer. The task's branch and uncommitted work travel as a git bundle into a worktree there, on the same branch, and its earlier turns come along so the harness picks up where the other one stopped. The old session is archived and links to the new one. **Rerun** has the same picker.

## Learning

After a session has been quiet for 90 seconds (or right away when you mark it done or archive it), wisp runs a short **retro**: the same harness, read-only and without tools (Claude Code runs it on Haiku), reads a digest of the turns it hasn't seen yet. The digest holds your requests and follow-ups, questions and answers, failed tool calls and the commands run around them, and how each run ended. The retro then updates four small lists:

| | Everywhere | This project |
|---|---|---|
| **Preferences**: how you like agents to work | report style, git habits, "never …" | tooling, conventions, areas to leave alone |
| **Lessons**: a mistake and the way that worked | "use `python3`, not `python`" | "run tests with `node --test`; `npm test -- x` runs everything" |

The retro gets the current lists along with the digest, so when you change your mind it rewrites or drops the old item instead of adding a contradicting one. Each list holds at most 10 items of 180 characters or less, and the digest is capped at 10k characters, so the prompt block stays small. Every later turn gets the lists in its system prompt, and the current request always wins over them.

**Memory** (Settings → *Memory*, or `⌘K` → *Memory*) has a tab for each scope (Everywhere, then each project) with its preferences and lessons, the retro that taught each one, and an estimate of the tokens it adds to the prompt. You can edit, add or forget any item. The *Retros* tab is a timeline of every run: what it added or removed, *nothing new*, or why it failed. Switching Memory off stops both learning and applying. The data lives in `~/.wisp/preferences.json`, and the API is `GET/PUT /api/preferences`.

## Telemetry

wisp sends anonymous usage stats and error reports to [PostHog](https://posthog.com) so we can see which agents people use and what breaks. The code is in [`server/telemetry.js`](server/telemetry.js).

**What is sent:** a random install id (not tied to you or your machine), the wisp, OS, Node and agent CLI versions, and per run: agent, model, mode, effort, status, duration, token counts and cost, how many files changed, and which presentation block types came back. Errors include a stack trace and message with your home directory and file paths removed, cut to 500 characters.

**Never sent:** prompts, replies, agent output, file contents, project names, paths or repo URLs.

**Opt out** with any of these:
- Settings → *Anonymous usage stats*
- `WISP_TELEMETRY=0`
- `DO_NOT_TRACK=1`

It is also off whenever `CI` is set.

### Feedback

Rate any result with 👍 / 👎 at the end of the turn (👎 asks for an optional line on what went wrong), type `/feedback <your note>` in any prompt box, or use `⌘K` → *Send feedback*. It goes to the wisp team on PostHog as a `turn_rated` or `feedback` event.

**What is sent:** your rating and note (with your home directory replaced by `~`), the wisp version and OS. For a rated turn it also sends the run's harness, model, mode, status, duration and presentation block types. Your prompt, the agent's output and your code are **never sent**.

You send feedback on purpose, so it goes out even with usage stats off, under a one-off id. Offline, it waits in `~/.wisp/feedback-outbox.json` and is sent later. `WISP_FEEDBACK=0` turns it off and hides the thumbs.

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
