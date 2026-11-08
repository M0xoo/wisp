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
