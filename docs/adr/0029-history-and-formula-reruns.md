# ADR-0029: Task history is data with a snapshot of what made it; reruns can swap the formula

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "how about task history in this architecture, and rerun in another formula?"
- Builds on ADR-0026, 0027, 0028.

## History

- **History is data, never configuration.** Turns, activity, answers, changes and cost live in the store's event
  log (ADR-0004) on the computer that ran the task. Peers see it by subscribing (ADR-0010). `wisp apply` never
  writes or deletes history, and `--prune` never removes a task.
- **Every task keeps a snapshot of what made it.** At start, the task records its spec plus the **effective
  formula**: the resolved agent profiles, crew member, team, connectors, settings and harness versions it ran
  with, stored once by content hash (identical snapshots are shared), with secrets as references. So a task
  still explains itself after the formula changes, after a crew member is renamed or pruned, or on another
  computer. The task head shows "ran with <formula name> @ <short hash>" and, when the formula has changed
  since, "changed since: reviewer's model, +1 connector".
- **History as code:** `wisp ls --formula team.yml`, `--agent reviewer`, `--crew Ada`, `--workflow nightly`,
  `--since 7d`; `wisp task history <id> [--json]`; `wisp history export --since 30d > history.jsonl` (scrubbed);
  the same queries in the SDK. A `retention` setting (resource kind `setting`, owner runtime) declares how long
  history is kept and what's archived, per project.
- **Lineage is explicit:** `rerunOf`, `forkOf`, `workflowRun`, `triggeredBy`, `crewJob`, `formula@hash`. The GUI,
  TUI and CLI show a task's family; the SDK walks it.

## Rerun with another formula

- `wisp rerun <id> --formula other.yml` runs the same ask from the same starting point (base commit, steps)
  under another setup. **Precedence:** explicit flags > the task spec's own fields > the formula's defaults.
- **Names resolve against the new formula.** If the spec names `agent: reviewer`, the new formula's `reviewer` is
  used, which is the point (try your new reviewer on old tasks). A name the new formula doesn't have is shown in
  the plan before anything runs, with the choice: use the original's snapshot for it (`--fill-from-snapshot`)
  or stop.
- **Compare setups:** `wisp rerun <id> --formula a.yml --formula b.yml` (or `--formula a.yml,b.yml`) runs one
  rerun per formula and opens them side by side in the compare view (v1's Try it two ways, now across whole
  setups), with each run's cost, time, changes and goal verdict. Several task ids, a recipe or a workflow
  can be rerun the same way, so a team can **evaluate a new formula against last week's real tasks**
  (`wisp rerun --last 20 --project api --formula new-team.yml`) with one report at the end.
- **The original snapshot is a formula too:** `wisp task formula <id> > as-it-ran.yml` writes it out, so any
  past run's setup can be reapplied or diffed (`wisp diff -f as-it-ran.yml`).

## Consequences

- runtime stores a `formula_snapshot` table (hash → resolved formula), referenced by tasks.
- The compare view and its CLI/TUI forms take N reruns, not only two.

## What a task had and what it used: skills, MCP servers, tools (added 2026-11-09)

**Declared** (ADR-0028 kinds): `skill` (from a path, a module or inline), `connector` (MCP servers: command or URL,
env as secret refs, which agents and modes get them), `tools` (which of wisp's own MCP tools an agent sees, and each
harness's built-in tool permissions: allowed and denied tools, the permission mode). An agent profile lists the
skills, connectors and tools it gets, so `agent.reviewer` means the same capabilities everywhere.

**Recorded on every task, at start** (in its formula snapshot):
- **Available:** every skill (name, source, content hash), every MCP server (name, command or URL, version reported
  at `initialize`, the tools it offered), wisp's tools exposed, the harness's tool permissions and mode, and the
  harness and model versions. Skills and MCP servers the harness picked up **outside wisp** (for example
  `~/.claude/skills`, the CLI's own MCP config) are recorded too, by name and hash, so nothing that shaped the run
  is invisible.
- **Used:** from the transcript, which skills were loaded, which MCP tools were called (how often, by which
  server), which built-in tools ran, and which calls were blocked.

**Shown wherever the task is read** (live, shared, tracked in `.wisp/`, adopted):
- App and TUI: a **Setup** section in the task's details lists *available → used* for skills, MCP servers and tools.
  Each item links to its declaration (or "outside wisp"), and a server that has changed since shows "changed
  since: v1.4 → v1.6".
- CLI: `wisp task setup <id>` (`--json`). SDK: `task.setup()`.
- **Sharing and rerunning:** the plan lists what the task needs that the receiver doesn't have ("needs the
  `linear` MCP server, the `release-notes` skill"), offers to add them from the shared snapshot (secrets asked
  for), and `--fill-from-snapshot` covers them on a rerun.
