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
{ "url": "http://127.0.0.1:4477", "port": 4477, "pid": 4242, "version": "0.7.0", "apiVersion": 1 }
```

The CLI, SDK and MCP server use it to find wisp, and start a headless server (`wisp --no-open`)
if none answers. Opening the desktop app later attaches to that server.

## MCP

`wisp mcp` is a stdio MCP server with these tools:

| Tool | What it does |
|---|---|
| `wisp_launch` | Start a task (`prompt`, `cwd`, `agent`, `mode`, `model`, `effort`). `wait: true` blocks until it finishes or asks. |
| `wisp_wait` | Block until a session finishes or asks (`timeout_seconds`, default 240), then return it. |
| `wisp_get` | State + latest presentation as markdown, plus any pending question. |
| `wisp_reply` | Follow up; answers a pending `ask_user` question if there is one. |
| `wisp_list` | Sessions, newest first (`state`, `cwd`, `limit`). |
| `wisp_stop` | Stop a run. |
| `wisp_agents` | Installed harnesses and their models. |

`cwd` defaults to the directory the MCP client started `wisp mcp` in, usually the project.

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
wisp reply <id> "also handle the empty list" [--queue] [--wait]
wisp stop <id>
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
`answer` · `wait` · `stop` · `update` · `remove` · `takeover` · `upload` · `events`.
Errors throw `WispError` with `status` and the response `body`.

Also exported: `wisp-agents/render` (`blocksToMarkdown`, `sessionToMarkdown`),
`wisp-agents/protocol` (`systemPrompt`, `parsePresentation`) and `wisp-agents/server`
(`startServer`, to embed wisp in another Node process).

## HTTP API

`GET /api/openapi.json` returns the full OpenAPI 3.1 document. The routes:

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ ok, version, apiVersion, pid, url }` |
| GET | `/api/agents` | installed harnesses, models, thinking levels |
| GET · PATCH | `/api/config` | launcher defaults, projects, webhooks |
| GET · POST | `/api/projects` | list / add a folder |
| PATCH · DELETE | `/api/projects/:id` | rename, recolor, remove |
| GET | `/api/sessions` | summaries; `?state=running,waiting&agent=&project=&cwd=&archived=&limit=` |
| POST | `/api/sessions` | launch: `{ prompt, cwd, agent, mode, model, effort, attachments }` |
| GET · PATCH · DELETE | `/api/sessions/:id` | full record / `{ title, state, unread, archived }` / delete |
| GET | `/api/sessions/:id/wait?timeout=60` | long-poll (max 290 s) until it finishes or asks; `timedOut` if not |
| GET | `/api/sessions/:id/presentation` | `{ blocks, markdown, ask, changes, stats, … }`; `?turn=<id\|index>`, `?format=markdown` |
| POST | `/api/sessions/:id/reply` | `{ text, attachments?, queue? }` |
| POST | `/api/sessions/:id/answer` | `{ text }` for a pending `ask_user` |
| POST | `/api/sessions/:id/stop` | |
| DELETE | `/api/sessions/:id/queue?item=` | cancel a queued follow-up |
| GET · POST | `/api/sessions/:id/takeover` | resume command / open it in the terminal |
| POST | `/api/uploads?name=&type=` | raw body (`application/octet-stream`) → `{ id }` for `attachments` |
| GET | `/api/events` | SSE: `summary`, `activity`, `turn`, `finished`, `removed`, `config`, `ping` |

Session `state`: `running` → `waiting` (blocked on a question) → `review` (finished, unread) →
`done` (marked done by the user).

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
