---
name: wisp
description: Delegate coding tasks to background agents (Claude Code, Codex, opencode, Cursor, Antigravity, Grok) through wisp, then read back their presentation (summary, diffs, tests). Use when the user asks to "send this to wisp", run something in the background or in parallel, fan a task out to other agents, or check on / follow up a wisp session.
---

# wisp: hand tasks to background agents

wisp runs coding agents in the background and queues their results for the user. Each task
becomes a **session**; when the agent finishes it leaves a presentation (hero summary, diffs, test
runs, next steps) and the session waits in the user's queue. The user sees every session in the
wisp app, so anything you launch is visible to them.

Prefer the MCP tools if they are available (`wisp_launch`, `wisp_wait`, `wisp_get`, `wisp_reply`,
`wisp_list`, `wisp_stop`, `wisp_agents`). Otherwise use the `wisp` CLI below (`npx -y wisp-agents`
works in place of `wisp` if it isn't installed). Every command takes `--json`.

## Launch

```sh
wisp "fix the flaky auth test in test/auth.test.ts; run npm test to verify" --json
wisp "audit dependencies for known CVEs" --mode plan --agent codex --json
wisp "add pagination to /api/users" --cwd ~/code/api --wait     # block until done, print the result
```

Options: `--agent claude|codex|opencode|cursor|antigravity|grok`, `--mode plan|edits|auto`, `--model ID`,
`--effort low|medium|high`, `--cwd DIR` (default: current folder), `--also DIR` (another folder the
same agent works in, repeatable: e.g. the API and its web app), `--wait`, `--json`.
`--json` prints the session summary; its `id` is what every other command takes.

Write the prompt as a self-contained brief: the agent cannot see your conversation. Include the
goal, relevant files, constraints, and how to verify (which test command to run).

## Follow the session

```sh
wisp wait <id>            # block until it finishes or asks a question; prints the presentation
wisp show <id>            # current state + latest presentation as markdown
wisp ls --state running,waiting
wisp reply <id> "also cover the empty-list case"   # follow-up; answers a pending question too
wisp stop <id>
```

`state` is one of `running`, `waiting` (blocked on a question to the user), `review` (finished,
unread by the user) or `done`.

## Rules

- **Don't answer questions meant for the user.** When a session is `waiting`, relay the question
  to the user unless they already told you the answer. Only then `wisp reply`.
- **Mode is a permission level.** Default to what the user picked in wisp (omit `--mode`). Use
  `--mode plan` for read-only investigations. Only use `--mode auto` if the user asked for it.
- **Changes land on a branch, not in your checkout.** In a git repo wisp runs each task in its own
  worktree on a `wisp/…` branch (`wisp show` names it). Read or merge that branch, or `wisp ship <id>`
  to open a PR. Pass `--no-worktree` only when the user wants the edit in their working copy.
- **Report the result, not the transcript.** Summarize the hero line, files changed and test
  outcome from `wisp show`; point the user at the session in wisp for the full presentation.
- `wisp wait` can take minutes. If you have other work, launch first, do it, then wait.
