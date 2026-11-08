# wisp v2 positioning: Agents as code

Decided 2026-11-08 by the lead, at the owner's request ("choose one: what is wisp *as code*?").

## The category: **Agents as code**

Infrastructure as code made servers something you declare, review, version and reproduce. wisp does the same for
the AI agents that write your software: **your coding agents, crew, machines and workflows, declared in one
file, run anywhere.**

- **Why not "software factory as code":** vague and enterprise-flavoured; it promises an outcome we can't show in
  one screenshot. **Why not "agent orchestration as code":** orchestration is one feature (workflows); the file
  also holds the team, the machines, the tools and the rules. "Agents as code" is short, reads like a category,
  and maps one to one onto what's in `wisp.yml`.
- **Tagline:** *Your AI dev team, as code.*
- **One-liner:** wisp runs Claude Code, Codex, Cursor and every other coding agent in parallel, on any of your
  machines, from one file you can commit, review, share and rerun. GUI, terminal UI and CLI on top.

## What we can honestly say is new (to verify before the launch: researcher task)

- Other projects declare agents in YAML for **their own framework** (e.g. CrewAI's agents.yaml/tasks.yaml for
  Python agents), and CI systems declare pipelines. As far as we know, **no open-source project declares a team of
  real coding-agent CLIs** (Claude Code, Codex, Cursor, …) with their accounts, the machines they run on, their
  worktrees, schedules, goals and workflows, and runs it locally, across your computers and in the cloud, with
  a GUI, a TUI and a CLI over the same file.
- Claims ship only after the researcher's check (competitors: Orca, T3 Code, Paseo, cmux, Multica, Paradev,
  CrewAI, LangGraph, Dagger, GitHub Agentic Workflows). Numbers in posts come from verified runs.

## The codebase carries its agent history (ADR-0033)

A repo built mostly by agents keeps the tasks that built it in `.wisp/`: `wisp blame` shows which task wrote a
line and why, `wisp resume` picks up last month's task on today's code, and new agents read the past decisions
before they touch a file. **Provenance for agent-written code.** No other tool we know does this (verify).

## Proof points to build into the launch

1. `wisp.yml` of a real team (reviewer, fixer, nightly dependency bot) → `wisp apply` → it runs.
2. `wisp task export` → a teammate runs the same task on their code with `wisp run -f`.
3. A workflow fanning one audit out to Claude and Codex, judged, with one budget.
4. The same file deployed to a grid box with `wisp grid deploy`.
5. Speed: 5 ms cold start, 11 MB idle, one binary (measured; recheck at release).

## What changes at the end of v2 (the docs rework)

README, the site (trywisp.dev: home, guides, integrations, agents pages), the CLI and formula reference
(generated from the catalogue and schemas), the plugin guide, the SDK guides (TypeScript, Python), recipes
of formulas, a migration guide from v1, and the launch post. Owners: marketing (copy, site), the lead
(review), the coder (generated references).

## Site rule: every feature shows all four ways in

Each feature on the site ends with one small line naming how to do it from the **App**, the **TUI**, the **CLI**
and the **SDK** (e.g. `App: Share · TUI: s · CLI: wisp share · SDK: task.share()`). It's one line, not a section:
the docs carry the details. It says what ADR-0024/0028 guarantee: anything is possible from wherever you work.
