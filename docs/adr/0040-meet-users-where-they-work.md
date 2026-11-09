# ADR-0040: Every feature works inside wisp and from wherever the user already works

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "always think that wisp can be used inside the wisp apps or from other places, for every
  feature; we should not expect users to change their flows or their harness."
- Extends ADR-0022 (CLI covers the GUI), 0024 (frontends are plugins), 0035 (adopt outside sessions).

## Decision

**wisp never asks a user to change how they work.** Someone who lives in Claude Code, Codex or Cursor, in their
editor, in their terminal, in CI or in Slack gets every feature from there, as well as from wisp's own apps.

Every feature is designed against this checklist, and its ADR says which of these it reaches, and why it skips any:

| Place | How wisp reaches it |
|---|---|
| wisp's app, TUI, CLI, SDK | ADR-0022/0024: the same commands, a parity test per frontend |
| **Inside any harness** (Claude Code, Codex, Cursor, opencode, Copilot, Grok, Antigravity) | wisp's MCP server exposes the command catalogue as MCP tools (generated, with the same capability sets), and the `wisp` skill teaches the agent when to use them. `wisp skill install --agent X` sets both up once. The user keeps their harness; their agent gains wisp. |
| **Their harness's own sessions** | ADR-0035: sessions run outside wisp are adopted (session-end hooks, or watching the CLI's store), so tracking, sharing, blame and history work without starting anything from wisp |
| **git** | commit trailers, `.wisp/` in the repo, an optional `prepare-commit-msg` hook that links commits to the task that made them even when no wisp is running |
| **CI** | a GitHub Action (`wisp-agents/action`) and a plain container image: run a formula, a workflow or a task in CI, post the report on the PR, gate on a goal |
| **Editors** | the MCP server already works in editors that speak MCP. A thin VS Code and JetBrains extension (blame gutter, Open in …, Repo history) comes later, built on the SDK |
| **Chat** | the channels (Slack, Telegram, Discord, GitHub comments, email, ntfy): start, steer, answer, approve |
| **The browser and the phone** | wisp Cloud links and the Android app, for anyone without wisp installed |

**Rules that follow:**
- **No feature exists only in wisp's UI.** If an agent in Claude Code can't reach it through MCP, it isn't done.
  The MCP tool list is generated from the catalogue, so this is checked: `tools/check` fails a command with no MCP
  exposure unless it's marked `ui-only` with a reason.
- **Passive by default:** tracking and history must work when the user never opens wisp (adopt, hooks, trailers).
  wisp adds value to the user's flow; it doesn't replace it.
- **Their config wins:** wisp reads and respects the harness's own settings, skills, MCP config and permissions,
  records them (ADR-0029), and never rewrites them without asking.

## Consequences

- The MCP server becomes a full frontend (like the CLI), generated from the catalogue, with goldens of its tool
  list. The skill text is generated from the same catalogue, with hand-written guidance on top.
- New deliverables: the GitHub Action and container image, the git hook, and later the editor extensions.
- The docs (ADR-0039) show the "from your harness" way on every how-to, next to App, TUI, CLI and SDK.
