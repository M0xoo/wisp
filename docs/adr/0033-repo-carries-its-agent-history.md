# ADR-0033: A repo carries the agent work that built it (`.wisp/`)

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "a codebase has a `.wisp` folder with the tasks that produced the codebase itself, where a dev
  can pick up an old task and start from it: a new way to manage codebases written mostly by agents."
- Builds on ADR-0026 (formulas), 0027 (task specs, sharing), 0029 (history snapshots).

## Decision

**A project can keep its agent history in the repo, in `.wisp/`, committed with the code.**

```
.wisp/
  wisp.yml              the project's formula: its agents, crew, workflows, rules (ADR-0026)
  tasks/
    2026/11/01a1bc-fix-flaky-login.task.yml     the task spec (ADR-0027): steps, agent, base, goal, formula@hash
    2026/11/01a1bc-fix-flaky-login.report.md    the answer, as markdown (optional)
  formulas/<hash>.yml   the formula snapshots tasks ran with (ADR-0029), shared by hash
  history/              full transcripts, opt-in only (compressed .jsonl.zst, or kept in git notes)
  README.md             what this folder is, generated
```

- **One file per task, named by id:** two branches never conflict on the same file. Specs are small text,
  reviewable in PRs ("this PR was produced by these 3 tasks"), and scrubbed like any share (ADR-0027).
- **What's committed is the project's choice** (in `.wisp/wisp.yml`: `history: { keep: spec | report | full }`).
  The default is spec + report: small, no transcripts, no private paths. Full history is opt-in, and goes in
  git notes or `history/` with compression so the repo stays light.
- **Linked to commits:** when wisp ships a task (Ship it), each commit gets a trailer, `Wisp-Task: 01a1bc`
  (and `Co-Authored-By` for the agent). The task file lists its commits and its PR. So both directions work:
  code → task, task → code.
- **Picking up old work:**
  - `wisp blame <file>:<line>`: which task wrote this line, its prompt, its reasoning summary, and the PR.
  - `wisp log [path]`: the project's history as tasks, not just commits ("who asked for what, which agent
    did it, did the goal hold").
  - `wisp resume <task>` continues an old task from where it stopped, on today's code: its spec, the summary
    of what happened and its report become the context of a new task (a fork, ADR-0027, across time and across
    developers). `wisp rerun <task>` replays it from its original commit (ADR-0029).
  - `wisp tasks --touching auth/` finds every task that changed a path, so a new developer or agent can read
    why the code is the way it is before changing it.
- **Agents use it too:** wisp's MCP tools give agents read access to `.wisp/` (`wisp_history`: past tasks
  that touched the files they're editing). A new task on a file starts knowing the decisions made there.
  That's the agent-native answer to "why is this code like this?".
- **Created by `wisp init`** in a repo, or on by default for projects added to wisp
  (`project: { repoHistory: true }`), and switched off per project.

## Consequences

- runtime writes task files on Ship it and on Done (when the project opts in). git and ship add the trailers.
- The share format and the `.wisp/tasks/*.task.yml` format are the same, so a task file in a repo is
  already a share.
- Positioning: this is "agents as code" applied to the codebase itself: provenance for agent-written code.
  It goes in the launch story (marketing/positioning-v2.md).

## Blame takes any pointer, and every frontend shows it (added 2026-11-09)

`wisp blame` answers "which task made this?" for whatever you point at:

| Input | Answer |
|---|---|
| `file:line` or `file:10-40` | the task(s) behind those lines (through git blame → commit → `Wisp-Task` trailer) |
| a file or folder | every task that shaped it, newest first, with how much of it each wrote |
| a commit sha or range (`a1b2c3`, `main~10..main`) | the task(s) that made those commits |
| a PR (`#812`, a PR URL) | the tasks that produced the PR, in order, with their prompts and goals |
| a task id | its commits, PR and files (the reverse direction) |

Answers come from the commit trailers and `.wisp/tasks`, so they work offline and on any clone. Code with no
task behind it (written by hand) says so. The SDK has the same (`w.blame(target)`), and agents get it through MCP.

**In the GUI and the TUI** (designed with the UI work, not a CLI port):
- **A "why" gutter in every diff and file view:** each run of lines shows a thin mark coloured per task. Hover or
  focus it (TUI: `b` on a line) to get a card with the task's title, its agent, the prompt that asked for it,
  the one-line reason from its report, the PR, and the actions Open task, Resume, Rerun.
- **Commits and PRs are clickable everywhere:** a sha or `#812` in a transcript, a report, Ship it or the PR panel
  opens a popover listing the tasks behind it, and the Changes panel groups a PR's diff by the task that wrote
  each part.
- **A project's story:** a timeline view (GUI page, TUI screen) of `wisp log`: tasks as a river along the commit
  history, filterable by path, agent, crew member or workflow. Pick a folder to see who (which tasks) built it.
- **Paste anything into the palette:** a sha, a PR link, `file:line` or a task id in ⌘K (TUI: Ctrl-K) jumps
  straight to its blame card.

## Any harness can read the history, with or without wisp running (added 2026-11-09)

Four ways in, from the most to the least integrated:
1. **wisp's MCP server.** Tools: `wisp_history` (tasks touching paths), `wisp_blame` (any target above),
   `wisp_task` (one task's spec and report), `wisp_resume` (ask the user to resume one).
   - A run wisp starts gets it automatically, with its per-task token (ADR-0008: read-only on history).
   - A harness the user opened by themselves adds `wisp mcp` once: `wisp skill install --agent claude|codex|cursor|…`
     writes the MCP entry and wisp's skill for that harness.
   - When no wisp server is running, `wisp mcp` reads `.wisp/` and git directly, so it works offline on any clone.
2. **The CLI from the agent's shell:** `wisp blame <target> --json`, `wisp tasks --touching <path> --json`,
   `wisp task show <id> --json`, for harnesses without MCP.
3. **Plain files:** `.wisp/tasks/*.task.yml` and `*.report.md` are readable text, so any agent can `cat` them.
   `wisp init` adds a short section to the repo's AGENTS.md (and CLAUDE.md if present): "Before changing a file,
   read the tasks that shaped it: `wisp tasks --touching <path>` or `.wisp/tasks/`."
4. **Context injection:** when wisp starts a task, it can attach the most relevant past tasks for the files in
   play (title, reason, link) to the prompt, so the agent starts informed without having to ask. This is a
   project setting (`history: { inject: true }`) and is off by default.

Reading is always allowed to whoever can read the repo. Starting, resuming or rerunning a task goes through
wisp and its permissions; an outside harness can only *ask* (`wisp_resume` creates a request the user approves).

## The user decides which tasks the repo tracks (added 2026-11-09)

- **Per project, a mode** (`.wisp/wisp.yml` → `history: { track: auto | ask | manual }`, default `ask`):
  - `auto`: every task that ships or is marked done in that repo is saved;
  - `ask`: when such a task ends, its report shows **Save to repo** (one click, with the level and a preview of
    what's written, scrubbed);
  - `manual`: nothing is saved unless the user adds it.
- **Add any task, anytime**, even an old one or one that ran before `.wisp/` existed:
  - App: **Save to repo** on the task's menu and its report.
  - TUI: `w` on a task.
  - CLI: `wisp track <id> [--level spec|report|full] [--repo <path>]`.
  - SDK: `task.track()`.
  - It writes the task file (and its formula snapshot) into `.wisp/tasks/`. The change is staged in the user's
    working tree for them to commit, or committed with the task's own changes when it ships.
- **Several repos:** a task that touched more than one repo (extra folders, a team across projects) asks which
  repos to save it in. Each one gets the same task id, so the copies stay linked.
- **Untrack and redact:** `wisp untrack <id>` (or Remove from repo) deletes it from `.wisp/` in the next commit.
  `--level` can lower what's kept (full → report → spec). Git history keeps old commits; the docs say so plainly.
- **The task shows where it's tracked:** a small "in repo" mark on the task row and in its head, with the path.
  `wisp tasks --tracked` lists them.

## A repo's history has its own place in the GUI and the TUI (added 2026-11-09)

When the open project has a `.wisp/` folder, the sidebar gets a second tab beside the task list:
**Tasks · Repo** (TUI: `Tab` switches, or `g r`). They're different things, so they look different.

- **Tasks** is what it is today: your tasks (running, needs you, done), live.
- **Repo** is the project's committed agent history, read from `.wisp/tasks` and git, from everyone who
  worked on it (teammates' tasks appear after a `git pull`):
  - grouped by time (this week, last month…), or by folder, PR or person, with a filter box (path, agent,
    person, words in the prompt);
  - each row shows the task's title, the person who ran it and the agent, the PR or commits it produced, the
    goal's verdict, and how much of today's code is still from it (`72% still in main`, from blame), so stale
    work stands out;
  - rows are history, not live tasks, so they get a different mark (a commit glyph, no status pill and no
    running animation) and open as a read-only report with Resume, Rerun, Fork, Blame, and Open the PR;
  - a task of yours that's also in the repo shows the "in repo" mark in Tasks, and opens the same report from
    Repo.
- **The repo view's own header:** the project's formula at a glance (agents, crew, workflows: from
  `.wisp/wisp.yml`), the track mode (auto, ask or manual), and the timeline view of ADR-0033's blame section.
- **Untracked local tasks** in a wisp-init'ed project show a quiet **Save to repo** on hover (in `ask` mode),
  so tracking is never more than one click away.
- Projects without `.wisp/` show no Repo tab. The empty state for a git repo offers **Track this repo's agent
  work** (`wisp init`).
