# wisp.accounts

Several accounts per harness, signing in from wisp, API keys, and the harness watch (v1
`server/accounts.js`, `agent-login.js`, `harness-watch.js`, `live-limits.js`, `services/install.js`).

## Intent

- A harness that keeps its login in one folder (Claude Code, Codex) can have up to 8 accounts; the CLI's
  own folder is the default and is never removed.
- An extra account's folder links to everything in the CLI's own folder except the login, so settings,
  skills, MCP servers and transcripts are the same on every account.
- A run gets the account you picked; one you start yourself skips an account at its limit or signed out,
  unattended work takes your pick as it is (wisp never switches accounts to get around a limit).
- Signing in runs the CLI's own login and shows its link, its code and a box to paste a code back; wisp
  never sees a password. A CLI that only asks on a terminal gets one (agy, script(1) on Linux).
- An API key pasted into wisp goes where the CLI keeps it; wisp only says which providers have one.
- The first run of a harness pins its program (path, size, sha256, version); a different program later is
  an update (newer version, same install folder) or a warning, and with Ask before running a changed
  harness on, its turn waits until you trust it.
- A Codex account's usage windows can be read without spending anything (its app-server).
- wisp can install a harness it knows how to (opencode) into its own tools folder.

## Not yet

Copying Claude's `.claude.json` into an extra account, the periodic live-limits read while work waits
(the read itself is `accounts.limits`), and the harness disk (This Mac → Free up space).
