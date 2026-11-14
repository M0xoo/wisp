# ADR-0028: Code first: wisp is a programmable orchestrator; GUI, TUI and CLI wrap it

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "wisp as code should be the direction: everything possible as code; the GUI, CLI and TUI
  are wrappers. Users orchestrate with wisp in their own code with formulas and tasks. Make everything fit:
  machines, agents, harnesses, crew. Find what else should be declarative."
- Extends ADR-0026 (resources, formulas) and ADR-0027 (task specs). With ADR-0024 (frontends are plugins).

## The principle

**Anything a user can do or set up in wisp is a resource operation or a task operation, available as code**
(a formula, the SDK, the CLI), and the three frontends are views over those. A feature isn't done until it is
declarable, exportable and scriptable. `tools/check` enforces it: every command is either a resource kind's
`apply` or a task operation, or it's marked `ephemeral` (UI-only state such as an open panel) with a reason.

## Every resource kind (from v1's config.json, its 57 settings keys and every file in ~/.wisp)

| Kind | Owner plugin | What it declares (v1 source) |
|---|---|---|
| `project` | runtime | path, colour, default agent; **worktree policy** (`worktree`, `worktreeOnDone`, `worktreeCleanup`, `worktreeMax`, `cloneDir`, `fixConflicts`, `.worktreeinclude`); **setup and run scripts** (Conductor's); **trust** (approved hooks, MCP servers, setup: project-trust) ; **instructions** (learned preferences, per-project notes) |
| `harness` | each harness module | installed or not, where from (`npm`, brew, a path), pinned/trusted version (harnesses.json, `harnessAsk`), its own defaults, `leanRuns`, live-limit reading |
| `account` | accounts | a harness account (login folder reference, never a token), which one is default per harness (`defaults.accounts`) |
| `agent` | runtime | **a named, reusable agent profile**: harness + model + effort + mode + account + subagent model + skills + connectors + instructions ("reviewer = codex, high, plan mode, the linear connector"). v1's defaults `agent/model/effort/mode/subagentModel` become the `default` agent. Anything that takes an agent (a task, a crew member, a team slot, a judge, Auto) takes a profile name or an inline one |
| `team` | runtime | a lead plus subagent slots (v1 `teams`, `teamPreset`, `subagents`) |
| `skill` | runtime | skills given to agents (wisp's `skills/`, crew kit skills), from a path or inline |
| `crew` | crew | member: name, role, agent profile, project, schedule, wake rules, team, parallel limit, paused, kit (skills, instructions), notebook (a file reference: it stays a file), `crewLayout` |
| `machine` | machines | a computer: transport (ssh, grid, grid-tunnel), address, name; **limits** (`maxRuns`, `cpuCeiling`, `memoryFloor`, `batteryHold`, the heavy-step lock); this computer's grid presence (`computer`, `remote`) |
| `connector` | connectors | an MCP server: command or URL, env (secret refs), which agents and modes get it, OAuth (reference) |
| `tools` | mcp | which of wisp's own MCP tools agents get, per agent profile or mode |
| `capability` | kernel | user-defined capability sets and API keys' scopes (`apikey`), the cap for each channel (`acceptChannels`), what a capped task may do |
| `channel` | channels | Telegram, Slack, Discord, GitHub, email, ntfy: enabled, who may speak, cap, routing, thread rules (tokens as secret refs) |
| `notification` | channels / shell | what notifies where: `notify`, `drainWatch`, `windowNotice`, webhooks out (`webhookTriggers`), phone alerts |
| `recipe` | automations | a parameterised task spec (ADR-0027) |
| `trigger` | automations | watchers (CI failed, issue labelled, PR review), cron schedules, incoming webhooks (signature rules), what spec each starts; `automationsPausedUntil` |
| `workflow` | workflows (new) | **orchestration**: see below |
| `goal` | goal | default judges and vote (`goalJudges`, `goalVote`), and goals attached to tasks or workflows |
| `budget` | budget | stop lines per account and window (`autoStop`, `limitHold`, `limitWait`, `liveLimits`), drain watch, spend caps per task/workflow |
| `router` | router | Auto's tiers, allowed arms, exclusions (`agentBeforeAuto`, `defaults.router`); learned stats stay data, not config |
| `pipeline` | router | what happens after a run (v1 conductor/pipeline.js): escalate on error, move on at a limit, best-of-N with a judge, review (`review`) |
| `plugin` | plugins | on/off, config, user plugins (path, gist, URL, version pin), part styles (ex-spells) |
| `app` / `pane` | stuff | My Stuff apps and panes with their source (a folder or inline), data schema, permissions; starters on/off (`apps`, `panes`) |
| `ui` | shell (device scope) | theme, view, transcript, read times, editor, terminal, spare card, keybindings, panel layout: per device, never applied from someone else's formula unless asked |
| `setting` | any | every remaining typed setting, owned by the plugin that declares it |
| `grid` | grid | the grid deployment itself (grid.json): sign-in providers, allow list, admins, limits, domains, mail, inbox channels; and `box` resources (a user's cloud computers, sandboxes) |

**Not resources** (data, not configuration): tasks' history, learned router stats, usage, logs, telemetry ids,
the `*Introduced` onboarding flags. A formula never sets telemetry or feedback switches, and never widens
permissions silently (see Trust below).

## Orchestration in code

- **Workflows** (a `workflow` kind) are DAGs of task specs:

  ```yaml
  workflows:
    - name: release-check
      on: { trigger: nightly }            # or run by hand / SDK / CLI: wisp run release-check
      tasks:
        tests:   { agent: fast, prompt: Run the test suite and report failures, output: json }
        triage:  { needs: [tests], if: "${{ tasks.tests.output.failed > 0 }}",
                   agent: reviewer, prompt: "Fix these: ${{ tasks.tests.output.failures }}",
                   goal: { text: tests pass }, pipeline: { on_error: escalate } }
        audit:   { matrix: { agent: [claude, codex] }, prompt: Audit the diff for security issues }
        report:  { needs: [triage, audit], agent: writer, prompt: Write the release note, on: studio-mac }
      budget: { usd: 20 }
  ```

  - `needs` (order), `if` (conditions on earlier results), `matrix` (fan-out), `on` (which machine), `output`
    (a task's structured result from its `wisp` block, typed when a schema is given), retries, timeouts,
    `budget`, and `concurrency`.
  - A workflow run is a parent task whose children are its tasks. It shows in every frontend as one row
    with its graph.
- **The SDK:** typed clients generated from the command catalogue and the resource schemas, for
  TypeScript (`wisp-agents/client`, v1's SDK extended) and Python (`wisp` on PyPI), with Rust from the crates
  themselves.

  ```ts
  const w = await wisp.connect();                  // the local wisp or any peer
  const t = await w.tasks.run({ agent: 'reviewer', prompt: 'Review PR 42', project: 'api' });
  for await (const e of t.events()) console.log(e); // live, from the topic
  const out = await t.result();                     // blocks + structured output
  await w.apply(formula);                           // the same as wisp apply
  ```

  - Every SDK call is a command or a topic subscription, so permissions, idempotency and live updates
    behave as they do in the GUI.
  - The SDK can drive any peer: your laptop, a grid box, a teammate's shared wisp, if allowed.

## Trust

- A formula from somewhere else (a URL, a gist, a teammate) is applied like a plugin: the plan shows, in plain
  words, every new permission, connector, channel, trigger and machine it adds. Secrets it references must
  already exist locally. Kinds that change who may act (`capability`, `channel`, `machine`, `trigger`)
  need an explicit confirmation, with `--yes` refused for them unless `--trust` is given.
- Device-scoped kinds (`ui`) and personal ones (`account`) are left out of exports by default
  (`--include ui,account`).

## Consequences

- Every plugin that owns configuration registers a resource kind. The verifier and `tools/check` fail a plugin
  that has settings or rows a user configures but no kind.
- The GUI's Settings, the TUI's forms and the CLI's verbs are generated from the kinds' schemas wherever a
  hand-made screen doesn't exist, so a new kind is usable everywhere on day one.
- New plugin: `wisp.workflows` (DAG runner on task specs). New published packages: the Python SDK.
