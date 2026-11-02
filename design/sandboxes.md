# Sandboxes

A sandbox is a box of its own on the user's wisp Grid for one piece of work: a fresh container
(gVisor, its own home, network and limits), so an agent can install, run and break anything
without touching the user's computer or their cloud computer. Three ways in:

| Who | How it's asked for | Lives as long as | Status |
|---|---|---|---|
| A task | `/sandbox <task>` in New task | the task (deleted with it) | built (this branch) |
| A subagent | its place is **Sandbox** (Delegate picker, `machine: "sandbox"` in `delegate`) | the lead task | proposed |
| A crew member | **Runs in: a sandbox** on the member (per job, or one of their own) | the job, or the member | proposed |

## What's built: /sandbox for a task

- **Grid** (`grid/sandboxes.js`, `grid/server.js`): `POST /api/sandboxes` (device token or the cloud
  wisp's Box secret) makes a row and returns `sb-<id>--<handle>.<domain>` and a token only that
  sandbox accepts (`wsb_<id>_<secret>`). hostd runs it as one more box `{ id: '<user>-sb-<id>' }`,
  so boxd, idle stop, `maxRunning` and `admit` all apply unchanged. `DELETE /api/sandboxes/<id>`
  removes the container, its home and its secrets. 5 per user (`sandboxes.perUser`).
- **Sign-ins**: a box starts empty. The user signs in to Claude once for all sandboxes (Settings →
  Cloud → Sandboxes): wisp runs `claude setup-token` on a pty, shows its link and a code box, and
  sends the token to the grid, sealed per user (`sandbox-login:claude`). hostd's `envFor` gives every
  sandbox `CLAUDE_CODE_OAUTH_TOKEN`; the user's own box never gets it. Nothing kept on the laptop.
- **wisp** (`server/services/sandbox.js`): `launchAny` sees `/sandbox`, makes the sandbox, adds it as
  a machine (`kind: 'grid', sandbox, task`), waits for it, carries the project as one git bundle
  (`packWork`: commits and uncommitted changes) to `POST /sandbox/seed` there (→ `~/code/<name>`,
  origin and git author kept), then launches on that machine. Deleting the task
  (`DELETE /sessions/<id>@<machine>`) deletes the sandbox.

## Rules (from the reviews)

- A sandbox belongs to one owner (a task, a delegate, a crew member or their job). It is **never a
  place you pick**: not in Run on, the Delegate place menu, *Their jobs run on*, or Machines. The page
  keeps them in `S.sandboxes`, apart from `S.machines`.
- It shows on its owner, in the machine pill's slot: `i-box` + **Sandbox** (`machinePill`), from the
  launch's first frame (the placeholder card) so nothing reflows when the box comes up.
- `i-box` is the sandbox icon; `i-lock` stays sign-in only.
- Every sandbox machine has `owner`: `{ task }`, `{ pending: when }` until the launch has its task,
  later `{ lead, member }`, `{ crew, job }`, `{ crew }`. One sweep (`sandbox.sweep`, at start and every
  10 min) drops the ones whose drop failed (`dropping`) and launches that never finished (30 min).
- Deleting a task drops its sandbox whatever the sandbox's own wisp answers (asleep, full, broken).
- Only Claude signs in for sandboxes (v1): a `/sandbox` launch runs Claude Code (Auto → Claude); another
  harness is refused up front. Never copy Codex's `auth.json` (rotating refresh tokens).
- Grid full: `/sandbox` and a delegation fail at once with the grid's message; a crew job stays
  queued and retries (backoff, ~30 min).
- `WISP_SANDBOX=1` in a sandbox: it publishes and shares nothing as its owner, makes no sandboxes,
  and only it accepts `POST /sandbox/seed`.

## Built: inside a sandbox

- **Root, safely:** boxd starts a sandbox as root under gVisor only (`--user 0`, Docker's default
  capabilities, `/usr/local/sbin/wisp-sandbox-init`). The init starts `rootd.mjs`, a root helper on a
  socket only uid 1000 can open, then runs wisp as uid 1000 (`setpriv`). The image's `sudo` is a thin
  client for that helper: gVisor doesn't honour setuid binaries, and that root is gVisor's, not the
  host's. A cloud computer's box keeps `--cap-drop ALL` and `no-new-privileges`, and has no helper.
- **Installs that last:** `apt`/`apt-get` (under sudo) write down what they install
  (`~/.sandbox/packages`) and the sandbox reinstalls it when it wakes (a box starts from the image).
  `npm -g` and `pip` install into the home, which stays.
- **Setup:** the project's `.wisp/sandbox.sh` runs once, when a sandbox gets the project.
- **Env vars:** Settings → Cloud → Sandboxes → Env vars: sealed per user on the grid, in every
  sandbox's environment (not wisp's own names). Values never come back.
- **Browser:** `wisp-desktop` starts Xvfb, Chromium (DevTools on 127.0.0.1:9222) and noVNC (6080).
  The sandbox's wisp adds a `browser` connector (`wisp-browser-mcp`: Playwright MCP on that Chromium)
  that every task's agent gets. The task's **Browser** tab in the side panel shows it live
  (`POST /api/sandbox/browser` → a one-time link to `p6080--sb-…`), and you can use it too.
- **Previews in frames of other sites:** a preview's cookie is `SameSite=None; Secure; Partitioned` on
  https grids and `*.localhost`, so wisp on a computer can frame a box's page (it failed before).
- **Room:** a sandbox gets 2.5 GB (`hostd.container.sandbox` overrides) and is admitted for that much.

## Built: subagents in a sandbox

- `machine: 'sandbox'` is a place (`relay.placeTeam`, `control.js machineOf`, the Delegate menu's
  **Sandbox** row). On the first delegation to that member, relay makes its sandbox
  (`sandbox.forDelegate`, owner `{ delegate: '<lead>:<child>', lead }`), claims a full bundle of the
  lead's work, sets the repo up there once (`seedDelegate`), and runs the delegation as for a delegate
  on a machine; its patch comes back to the lead. Delegating again reuses that sandbox.
- Deleting the lead deletes its delegates' sandboxes (`leadGone`, local and remote leads).

## Built: crew members in a sandbox

- `sandbox: '' | 'job' | 'own'` on the member, exclusive with `machine`, Claude Code or Auto only.
  `job`: a fresh sandbox per job, owned by that job (deleted with it). `own`: one kept for them,
  reused by every job, deleted when they leave the crew. Their project here goes along (`forCrew`).
- The member editor's *Their jobs run on* has **A sandbox per job** and **A sandbox of their own**;
  their profile says *in a sandbox per job* / *in their own sandbox*.

## Still open

1. Network policy (None / Packages / All): an egress proxy boxd puts in front of a sandbox's network.
2. Codex (and the other harnesses) signed in inside a sandbox: run their device login there; never
   copy a login file.
3. A warm sandbox per user to cut the 23.7 s cold start; a cached per-repo setup layer (needs runsc
   with an overlay `docker commit` can read, or a home-level cache).
4. `runsc checkpoint` for idle stop, so a woken sandbox keeps its running servers.
5. A reaper for done tasks' sandboxes (today they go when the task is deleted; Settings lists them).
6. Caddy issues one certificate per sandbox and preview name: watch the Let's Encrypt budget, or move
   to a wildcard certificate.
