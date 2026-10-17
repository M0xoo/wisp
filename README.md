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

[Quick start](#quick-start) · [Features](#features) · [CLI](#cli) · [Integrations](#integrations) · [Shortcuts](#keyboard-shortcuts) · [Architecture](#architecture) · [Adding a harness](#adding-a-harness) · [Roadmap](#roadmap)

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
| ❓ **Live questions** | Agents get an `ask_user` tool, so they can pause mid-run. Your answer goes straight back to the running agent. |
| 🧾 **Real diffs** | Edits come from the agent's own tool calls, so `diff` blocks show what actually changed. |
| 📥 **A queue** | Sessions sort into *Needs you*, *Working* (with a live one-line status), and *Done*. Archive what you don't need to see. |
| 💬 **Follow-ups that interrupt** | A follow-up sent mid-run interrupts the agent and resumes it with your message. Turn on **Queue** to wait for the run to finish instead; queued messages can be cancelled. |
| 🔎 **Command palette** | `⌘K` / `Ctrl+K` fuzzy-searches sessions, projects, and actions. |
| 🤖 **Any harness** | Claude Code, Codex, opencode, Cursor CLI, Antigravity CLI, or Grok Build. Pick the harness, model and thinking level together in the launcher; both are remembered per harness. Each card shows the harness it ran on. |
| 🖥️ **Take over** | Opens your terminal with the harness's resume command (`claude --resume <id>`, `codex resume <id>`, …) in the project folder. Works with Terminal, iTerm, Ghostty, Warp, cmux, kitty, WezTerm, GNOME Terminal, Konsole, Alacritty, Windows Terminal, PowerShell, or a custom command. |
| 📎 **Attachments** | Paste screenshots or drop images, video, logs, or PDFs into the launcher. |
| 🧠 **Learns as you go** | After a session goes quiet, a background retro records your preferences and the agent's lessons (a mistake and the way that worked), globally and per project. Later runs get them in their prompt. See [Learning](#learning). |
| 🌿 **A worktree per task** | In a git repo each task gets its own worktree and branch from `origin/main`, so parallel agents never collide. |
| 🚢 **Ship it** | One click commits, pushes and opens the PR. The card follows CI and reviews; **Merge** squash-merges and syncs your local main. |
| 🤝 **Subagents** | Give the lead agent a team on other harnesses (e.g. Claude Code hands tests to Codex ×3). It delegates through a `delegate` tool; their edits land in its worktree. See [Subagents](#subagents). |
| ⏪ **Checkpoints & rollback** | Every turn is snapshotted first. Restore to before any turn, revert a single file, or re-run a command block from the presentation. |
| ⚖️ **Compare** | Run one task on two harnesses side by side, and keep the better run. |
| 🧾 **Recipes & triggers** | Saved prompts with `{params}` (`wisp run release 0.8.0`), run by hand, on a schedule, when CI fails, or when an issue is labelled. |
| 📊 **Usage** | Spend, success rate and questions per project and per harness · model. |
| 📱 **Phone** | Questions and finished tasks on ntfy or Telegram; answer from there. |
| 🔐 **Permission modes** | Choose **Plan** (read-only), **Edits** (file edits auto-accepted), or **Full auto** for each launch. `Shift+Tab` in the prompt cycles modes. |
| 🔌 **Integrations** | An MCP server (`wisp mcp`), an agent skill, a scriptable CLI, a JS SDK, an OpenAPI-described HTTP API, and webhooks. Hand tasks to wisp from Claude Code, Codex, opencode, Cursor, scripts or CI. |
| 🪶 **No runtime dependencies** | The server uses only Node built-ins. Electron is needed only for the desktop app. |

## Quick start

> **Requirements:** macOS, Linux, or Windows; Node.js ≥ 20; and at least one harness installed and signed in: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`), [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), [Antigravity CLI](https://antigravity.google/docs/cli/headless/) (`agy`), or [Grok Build](https://x.ai/cli) (`grok`). Override a binary path with `WISP_CLAUDE_BIN`, `WISP_CODEX_BIN`, `WISP_OPENCODE_BIN`, `WISP_CURSOR_BIN`, or `WISP_ANTIGRAVITY_BIN`.

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
wisp --agent codex "add a test"   # harness: claude | codex | opencode | cursor | antigravity | grok
```

Scripting (every command takes `--json`):

```sh
wisp "add a test" --wait          # block until it finishes, print the presentation as markdown
wisp ls --state running,waiting   # list sessions
wisp show <id>                    # state + latest presentation
wisp wait <id>                    # until it finishes or asks you something
wisp reply <id> "also do X"       # follow up (answers a pending question)
wisp stop <id>
wisp ship <id> [--draft]          # commit, push and open a PR for a worktree task
wisp merge <id>                   # squash-merge its PR, fast-forward your local main
wisp run release 0.8.0            # run a recipe; values fill its {params} (or version=0.8.0)
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
│   ├── index.js           # HTTP API, SSE stream, static UI, uploads
│   ├── openapi.js         # OpenAPI document for the public API
│   ├── client.js          # JS SDK (wisp-agents/client), used by the CLI and MCP server
│   ├── mcp-wisp.js        # `wisp mcp`: wisp as tools for other agents
│   ├── render.js          # presentation → markdown
│   ├── runner.js          # session lifecycle, follow-ups, event normalization
│   ├── checkpoint.js      # per-turn git checkpoints, file revert, rollback, action exec
│   ├── protocol.js        # system prompt + ```wisp block parser (markdown fallback)
│   ├── mcp-ask.js         # ask_user MCP server
│   ├── store.js           # JSON-file persistence in ~/.wisp
│   ├── git.js             # worktrees, Ship it, PR status and merge (git + gh)
│   ├── recipes.js         # saved prompts with {params}
│   ├── triggers.js        # cron schedules and GitHub watchers
│   ├── remote.js          # phone: ntfy and Telegram, out and back
│   ├── machines.js        # other computers: SSH, a tunnel to wisp there, relayed sessions
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

## Worktrees and shipping

In a git repo, every launch (except Plan mode) runs in its own [git worktree](https://git-scm.com/docs/git-worktree) under `~/.wisp/worktrees/`, on a branch named `wisp/<task>-<id>` made from the remote's default branch (`origin/main`, fetched first; `HEAD` when there is no remote). Uncommitted changes in your own checkout are not carried over, and dependencies aren't shared: the agent is told to install what it needs. The card shows the branch, and **Take over** opens the worktree.

**Ship it** (`S`) commits whatever is uncommitted (the message is drafted from the presentation as a conventional commit; edit it before shipping), pushes the branch and runs `gh pr create`. You need the [GitHub CLI](https://cli.github.com) signed in. From then on the card follows the PR every minute: checks (✓ / running / failing), the review decision, merged or closed. **Merge** runs `gh pr ready` for drafts and `gh pr merge --squash --match-head-commit <sha>`, so a branch that moved since you looked is never merged, then fast-forwards your local base branch (`git merge --ff-only`, or a ref update when it isn't checked out) and removes the worktree and branch. If a ruleset requires a review, Merge waits for the approval like `gh` does.

**Compare** (the **vs** button next to the harness picker) launches the same task on a second harness. Both get their own worktree and show up as one task in the feed, with a row per run; **Compare** on the task shows them side by side, and **Keep this** archives the others and deletes their worktrees.

Turn worktrees off in Settings → *Worktree per task*, with the launcher's **Worktree / In place** toggle, or per launch (`--no-worktree`, `"worktree": false`).

## Subagents

The launcher's **Subagents** button gives the lead agent a team: up to 6 members, each with its own harness, model, thinking level, name, a **Use for** note that tells the lead when to pick it, and a **×N** copies count (`Codex ×3` → `codex#1`…`codex#3`). The lead gets a `delegate` tool on wisp's MCP server; tasks sent in one call run in parallel in the lead's folder, and delegating to the same member again resumes its conversation. Claude Code, Codex, opencode and Grok can lead; Cursor and Antigravity can be members. **Save as preset** stores a team for later. Subagent edits count as the lead's, so they show up in its diffs, rollback and Ship it. API: `subagents` / `preset` on `POST /sessions`, `/teams`.

## Checkpoints and rollback

Before each turn, wisp snapshots the git working tree (pinned at `refs/wisp/checkpoints/<session>/<turn>`). **Restore to before this turn** (turn bar, session menu or ⌘K) rolls back; **Re-apply turn** undoes that. `diff` and `files` blocks have a per-file **Revert / Re-apply**, and `actions`, `terminal` and `tests` blocks run their command in the project folder with one click.

## Automations

**Recipes** are prompts you send again and again. `{name}` in a recipe becomes a field you fill in when it runs:

```text
Prepare release {version}: update CHANGELOG, README and docs/, bump package.json, tag v{version}.
```

Make one from ⌘K → *Recipes*, or *Save as recipe…* on any card. A recipe may pin a project, harness, model and mode. Run it from ⌘K (*Run: Release*), from the Recipes view, or from a terminal: `wisp run release 0.8.0` fills the fields in order, `wisp run release version=0.8.0` by name.

**Triggers** launch sessions on their own while wisp is open (⌘K → *Triggers*):

| Kind | Fires when | Prompt fields |
|---|---|---|
| Schedule | a cron expression matches (local time), e.g. `0 9 * * 1-5` | your recipe's fields |
| CI failed | a GitHub Actions run fails (optionally on one branch) | `{name} {branch} {url} {id} {sha}` |
| Issue labelled | an open issue carries a label | `{number} {title} {body} {url} {author}` |

GitHub triggers poll with your `gh` login (every 2–60 minutes), so nothing has to reach your machine; the first check only records what already exists. Issue triggers start in Plan mode: issue text comes from whoever can open issues, so think twice before giving it Full auto.

## Usage

⌘K → *Usage* shows spend per day and, per project and per harness · model: spend, turns, how often the run worked (finished, not partial or blocked), how often the agent had to ask you, and the average time. Claude Code, opencode and Grok report cost (Grok only when its plan does); Codex, Cursor and Antigravity only report tokens, so their turns are counted but not priced. Also `wisp usage` and `GET /api/usage?days=30`.

## Phone

Settings → *Phone* sends questions and finished tasks to your phone and takes the answers back. wisp polls both services, so it works from anywhere without opening a port.

- **[ntfy](https://ntfy.sh)**: subscribe to the topic in the ntfy app. Notifications carry up to three buttons (the question's options, or *Mark done*); a tap sends a signed answer back. Use a long random topic (wisp suggests one): anyone who knows it can read the notifications, but only wisp can make answers that count.
- **Telegram**: create a bot with @BotFather, paste its token, then send `/link <code>` to the bot. Tap a button to answer, or reply to a message to answer in your own words or send a follow-up.

They receive titles, summaries and questions (with their context), never code or diffs.

## Machines

**Machines** (top bar, Settings → *Machines*, or ⌘K) runs agents on your other computers over SSH. Give it `user@host` or a `Host` from `~/.ssh/config` and press **Connect**:

1. wisp signs in with `ssh` using your keys, agent and config (never a password; `BatchMode=yes`, new host keys are trusted on first use).
2. On the machine it finds Node.js 20+ and starts `npx -y wisp-agents@<this version> --no-open` detached, or reuses the wisp already answering on its port (4477 by default).
3. It forwards a free local port to that wisp with `ssh -L` and relays its event stream.

Then **Pick projects on it**: the machine's git repos are listed, and folders autocomplete. In the launcher, **Run on** (next to the harness) picks where the prompt goes: this computer, any machine, or several at once. Each place shows its own project chips; Enter launches on all of them in parallel, and the runs land as one task with a row per machine. Each run executes on its machine, with worktrees, diffs, rollback, `ask_user`, subagents, compare and Ship it all working on that machine. Its sessions join your feed with a badge, answer from your phone like any other, open in VS Code, Cursor or Windsurf through Remote - SSH, and **Take over** opens `ssh -t <host>` resuming the agent in your terminal.

Nothing new listens on the network: wisp on the machine stays on its own `127.0.0.1`, and it keeps running (agents too) when this computer sleeps or disconnects; wisp reconnects on its own. **Stop wisp there** (the machine's ⋯ menu) stops it. The machine needs Node.js 20+ and the harness CLIs, signed in. Sessions there are `<id>@<machine>` in the API, CLI, SDK and MCP; recipes and schedules work with machine projects, while CI and issue triggers, usage and memory stay per machine.

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
