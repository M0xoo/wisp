# Integrating wisp

wisp is a local server. Everything the app does goes through its HTTP API, so anything that can
make an HTTP request (or speak MCP, or run a shell command) can launch agents into the same queue
and read their presentations back.

| Surface | Use it from | Entry point |
|---|---|---|
| **MCP server** | Claude Code, Codex, opencode, Cursor, Claude Desktop, Zed, any MCP client | `wisp mcp` |
| **Agent skill** | Claude Code, Codex, opencode (agents that load `SKILL.md`) | `wisp skill install` |
| **CLI** | shell scripts, CI, git hooks, editor tasks, Raycast/Alfred | `wisp "…" --json`, `wisp wait`, … |
| **JS SDK** | Node scripts, editor extensions, bots | `import { WispClient } from 'wisp-agents'` |
| **HTTP API** | anything else | `GET /api/openapi.json` |
| **Webhooks** | Slack/Discord bridges, notifiers, CI | `PATCH /api/config { webhooks }` |

All of them talk to the same server: a task launched from Claude Code over MCP shows up in the
wisp app like any other, with its question, diffs and presentation.

## Finding the server

The server binds to `127.0.0.1` (default port `4477`, `WISP_PORT` to change) and writes
`~/.wisp/server.json` (`WISP_HOME` to move it) while it runs:

```json
{ "url": "http://127.0.0.1:4477", "port": 4477, "pid": 4242, "version": "0.49.0", "apiVersion": 1 }
```

The CLI, SDK and MCP server use it to find wisp, and start a headless server (`wisp --no-open`)
if none answers. Opening the desktop app later attaches to that server.

## MCP

`wisp mcp` is a stdio MCP server with these tools:

| Tool | What it does |
|---|---|
| `wisp_launch` | Start a task (`prompt`, `cwd`, `agent`, `mode`, `model`, `effort`, `machine`, `subagents`). `wait: true` blocks until it finishes or asks. |
| `wisp_wait` | Block until a session finishes or asks (`timeout_seconds`, default 240), then return it. |
| `wisp_get` | State + latest presentation as markdown, plus any pending question. |
| `wisp_reply` | Follow up; answers a pending `ask_user` question if there is one. `agent` / `model` / `effort` move the task to another harness or model, and the new harness gets the conversation so far. |
| `wisp_list` | Sessions, newest first (`state`, `cwd`, `limit`). |
| `wisp_stop` | Stop a run. |
| `wisp_agents` | Installed harnesses and their models, and your machines with theirs. |
| `wisp_crew` | Your crew: each member's name, role, brief, folder, harness, schedule and jobs. |
| `wisp_crew_add` | Add a member (`name`, `role`, `brief`, `cwd`, `agent`, `model`, `effort`, `mode`, `cron`, `parallel`). `checkin: true` starts a first check-in. |
| `wisp_crew_edit` | Change a member (`member`: name, `@handle` or id, plus the fields to change, `paused` too). |
| `wisp_crew_remove` | Remove a member (`member`). Their jobs stay as tasks. |

`cwd` defaults to the directory the MCP client started `wisp mcp` in, usually the project.

Agents running *inside* wisp get the same control from wisp's own injected server: `wisp_available` (harnesses, machines, projects, presets), `wisp_launch` (start a task here or on a machine), `wisp_task` (follow up, stop, mark done, archive, rename or wait on another task) and `delegate`, which creates subagents on the fly on any harness, model or machine (`{ agent, model, effort, machine, name, prompt }`) when the task wasn't launched with a team. Subagents can't use them, and a task an agent started can start at most two levels more.

**Claude Code**

```sh
claude mcp add wisp -- npx -y wisp-agents mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.wisp]
command = "npx"
args = ["-y", "wisp-agents", "mcp"]
```

**opencode** (`opencode.json`)

```json
{ "mcp": { "wisp": { "type": "local", "command": ["npx", "-y", "wisp-agents", "mcp"] } } }
```

**Cursor** (`.cursor/mcp.json`) and **Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "wisp": { "command": "npx", "args": ["-y", "wisp-agents", "mcp"] } } }
```

If `wisp` is installed globally, use `wisp mcp` instead of `npx -y wisp-agents mcp`.

## Agent skill

[`skills/wisp/SKILL.md`](../skills/wisp/SKILL.md) teaches an agent when and how to hand work to
wisp through the CLI (or the MCP tools when present): how to brief, how to wait, and to relay a
waiting agent's question to the user rather than answer it.

```sh
wisp skill install                     # ~/.claude/skills/wisp
wisp skill install --agent all         # + ~/.codex/skills/wisp, ~/.config/opencode/skill/wisp
wisp skill install --agent claude --project   # .claude/skills/wisp in this repo
wisp skill                             # print it (pipe it into AGENTS.md, Cursor rules, …)
```

## CLI

```sh
wisp "fix the flaky auth test" --json            # → session summary JSON (has "id")
wisp "add a test" --agent codex --mode plan --model gpt-5 --effort high --cwd ~/code/api
wisp "bump deps and run the tests" --wait        # block, then print the presentation as markdown
wisp ls [--state running,waiting] [--cwd DIR] [--limit N] [--json]
wisp show <id> [--json]
wisp wait <id> [--json]
wisp reply <id> "also handle the empty list" [--queue] [--wait] [--mode plan|edits|auto] [--agent ID --model ID --effort LEVEL]
wisp stop <id>
wisp "fix it" --compare codex,opencode           # the same task on more harnesses, one worktree each
wisp "quick edit" --no-worktree                  # edit the folder in place
wisp ship <id> [--draft]                         # commit, push, open a PR (worktree sessions)
wisp merge <id>                                  # squash-merge it, fast-forward local main
wisp run <recipe> [values… | key=value…]         # run a saved recipe
wisp recipes [--json]
wisp usage [--days 30] [--json]
wisp computer [--json]                          # is this computer on your wisp Grid? its address there
wisp computer on [--grid HOST] [--no-open]      # add it (signs in first: prints a code to allow in a browser)
wisp computer off                                # take it off the grid
wisp -- show me where auth is configured        # a task whose first word is a command name
```

Exit code is non-zero on errors (unknown session, wisp not reachable, bad arguments).

## JS SDK

Zero dependencies, Node ≥ 20.

```js
import { WispClient } from 'wisp-agents'; // or 'wisp-agents/client'

const wisp = await WispClient.connect(); // { url, port, start: true }
const s = await wisp.launch({ prompt: 'fix the flaky auth test', cwd: '/path/to/repo', agent: 'claude', mode: 'edits' });

const result = await wisp.wait(s.id); // resolves when it finishes or asks
if (result.state === 'waiting') await wisp.reply(s.id, 'Yes, drop the legacy path');

const { blocks, markdown, changes } = await wisp.presentation(s.id);

for await (const { event, data } of wisp.events()) {
  if (event === 'finished') console.log(data.session.title, data.session.state);
}
```

Methods: `health` · `agents` · `config` · `updateConfig` · `projects` · `addProject` ·
`removeProject` · `sessions(filter)` · `session` · `presentation` · `launch` · `reply` ·
`answer` · `wait` · `stop` · `update` · `remove` · `takeover` · `upload` · `events` · `ship` ·
`merge` · `recipes` · `saveRecipe` · `runRecipe` · `triggers` · `usage`.
Errors throw `WispError` with `status` and the response `body`.

Also exported: `wisp-agents/render` (`blocksToMarkdown`, `sessionToMarkdown`),
`wisp-agents/protocol` (`systemPrompt`, `parsePresentation`) and `wisp-agents/server`
(`startServer`, to embed wisp in another Node process).

## HTTP API

`GET /api/openapi.json` returns the full OpenAPI 3.1 document. The routes:

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ ok, version, apiVersion, pid, url }` |
| GET | `/api/agents` | installed harnesses, models, thinking levels (`?fresh=1` detects again) |
| POST | `/api/agents/recheck` | detect harnesses and models again, here and on online machines |
| GET · PATCH | `/api/config` | launcher defaults, projects, webhooks |
| GET · POST | `/api/projects` | list / add a folder |
| PATCH · DELETE | `/api/projects/:id` | rename, recolor, remove |
| GET | `/api/sessions` | summaries; `?state=running,waiting&agent=&project=&cwd=&archived=&limit=` |
| POST | `/api/sessions` | launch: `{ prompt, cwd, agent, mode, model, effort, attachments, worktree, compare, goal }`; `goal: { text, max }` keeps it going until wisp's check finds it holds |
| GET · PATCH · DELETE | `/api/sessions/:id` | full record / `{ title, state, unread, archived, discardWorktree }` / delete |
| GET · POST | `/api/sessions/:id/ship` | what would ship / `{ title, body, draft }`: commit, push, open or update the PR |
| POST | `/api/sessions/:id/pr` | refresh PR checks and review now (also polled every minute) |
| POST | `/api/sessions/:id/merge` | squash-merge the PR, fast-forward the local base branch → `{ pr, sync }` |
| GET · POST | `/api/recipes` | list / save `{ name, prompt, cwd, agent, model, effort, mode }` |
| GET · PATCH · DELETE | `/api/recipes/:idOrName` | one recipe |
| POST | `/api/recipes/:idOrName/run` | `{ params, words, cwd, … }` → session summary |
| GET · POST | `/api/triggers` | list (with `nextAt`) / add `{ kind: schedule\|ci\|issues, cwd, cron, branch, label, every, prompt \| recipeId, … }` |
| PATCH · DELETE | `/api/triggers/:id` | edit, enable/disable, delete |
| POST | `/api/triggers/:id/run` | fire a schedule now, or poll a watcher now |
| GET · PUT | `/api/remote` | phone channels (ntfy, Telegram); tokens come back masked |
| POST | `/api/remote/test` | send a test message |
| GET · POST | `/api/machines` | machines (other computers over SSH) with state / add `{ target, name, port, command, autoConnect }` and connect |
| PATCH · DELETE | `/api/machines/:id` | edit, remove |
| POST | `/api/machines/:id/connect` · `/disconnect` · `/stop` | connect; close the tunnel (wisp keeps running there); stop wisp there (`{ restart }`) |
| GET | `/api/machines/:id/fs?q=` · `/discover` | folders and git repos on the machine; add one with `POST /api/projects { path, machine }` |
| GET | `/api/usage?days=30` | spend and outcomes per day, project and harness · model |
| GET | `/api/sessions/:id/wait?timeout=60` | long-poll (max 290 s) until it finishes or asks; `timedOut` if not |
| GET | `/api/sessions/:id/presentation` | `{ blocks, markdown, ask, changes, stats, … }`; `?turn=<id\|index>`, `?format=markdown` |
| POST | `/api/sessions/:id/reply` | `{ text, attachments?, queue?, mode?, agent?, model?, effort? }` |
| PUT · PATCH · DELETE | `/api/sessions/:id/goal` | set or replace the goal `{ text, max }` / `{ action: pause \| resume }` / drop it |
| POST | `/api/sessions/:id/answer` | `{ text }` for a pending `ask_user` |
| POST | `/api/sessions/:id/stop` | |
| DELETE | `/api/sessions/:id/queue?item=` | cancel a queued follow-up |
| GET · POST | `/api/sessions/:id/takeover` | resume command / open it in the terminal |
| POST | `/api/uploads?name=&type=` | raw body (`application/octet-stream`) → `{ id }` for `attachments` |
| GET | `/api/events` | SSE: `summary`, `activity`, `turn`, `finished`, `removed`, `config`, `ping` |

Session `state`: `running` → `waiting` (blocked on a question) → `review` (finished, unread) →
`done` (marked done by the user).

Launches in a git repo run in a fresh worktree by default (see the README). The summary's `branch`
names it and the presentation markdown ends with the worktree path, since the changes are not in
your checkout. Pass `"worktree": false` to edit `cwd` in place.

Rules every request must follow (they keep web pages from driving your agents):

- `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`.
- Non-GET requests must be `application/json` (uploads: `application/octet-stream`).
- An `Origin` header, if sent, must be one of those hosts.

```sh
curl -s localhost:4477/api/sessions -H 'content-type: application/json' \
  -d '{"prompt":"fix the flaky auth test","cwd":"'"$PWD"'"}'
curl -s "localhost:4477/api/sessions/$ID/wait?timeout=120"
curl -s "localhost:4477/api/sessions/$ID/presentation?format=markdown"
```

## Webhooks

wisp POSTs JSON to each webhook when a session finishes or starts waiting on a question:

```sh
curl -X PATCH localhost:4477/api/config -H 'content-type: application/json' \
  -d '{"webhooks":[{"url":"https://example.com/wisp","events":["session.waiting","session.finished"]}]}'
```

```json
{ "event": "session.finished", "session": { "id": "…", "title": "…", "state": "review", "preview": "…" }, "markdown": "## …", "at": 1792230000000 }
```

`events` is optional (default: both). Delivery is fire-and-forget with a 10 s timeout; failures
are logged and not retried. `PATCH` replaces the whole list; send `[]` to clear it.

Webhook bodies include the presentation markdown, which can contain code from your project. Only
point them at endpoints you trust.
