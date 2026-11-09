# wisp v2 positioning: Engineering as code

Revised 2026-11-09. The owner: "we're more than agents as code." Right: wisp declares the team, runs it, and the
repo keeps the work itself. So the category widens from **Agents as code** to **Engineering as code**, and
"agents as code" stays as the first of three pillars.

## The category: **Engineering as code**

Infrastructure as code put servers in the repo. wisp puts **the way your software gets built** in the repo: who
builds it (your agents and crew), how (workflows, rules, machines), and what was asked and why (every task,
linked to the code it wrote).

- **Hero (2026-11-09):** H1 *Your coding agents, as code.* · line 2 *Declare them. Run them anywhere. Track every line they
  write.* · kicker *Engineering as code · open source*. (Alternative kept: "Your coding agents, declared, run and tracked as
  code." Earlier: "Manage the code your agents write.")
- **Three pillars, in this order, organising the whole site:** **Declare · Run · Track.** Declare and Track are
  what's new (marked New); Run is what wisp already does best: **every harness, any machine, from anywhere.**
- **Tagline (secondary):** *Your AI dev team, and everything it did, as code.*
- **Three pillars:**
  1. **Declare** — agents, crew, machines, tools, rules and workflows as code in `.wisp/` (files with references, variables and modules, ADR-0034) (ADR-0026/0028).
  2. **Run** — any coding agent, in parallel, on any of your computers or in the cloud, from the app, the TUI, the
     CLI or your own code (ADR-0024).
  3. **Track** — every task is a file: share it, rerun it, resume it; the repo keeps them in `.wisp/`, so
     `wisp blame` tells you which task wrote a line and why (ADR-0027/0029/0033).
- **One-liner:** wisp runs Claude Code, Codex, Cursor and every other coding agent from one file in your repo, and
  keeps every task they did next to the code they wrote, so anyone can see why it's there and pick up where they
  left off.
- **Why not stay "Agents as code":** it describes pillar 1 only. The part nobody else has is pillar 3 (Track): code that remembers how it was made. "Engineering as code" holds all three, reads like a category, and still maps onto
  files in the repo.

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

## Site rule: every feature shows all four ways in, and the app is always shown

wisp is code first (ADR-0028): App, TUI, CLI and SDK are equal ways in. But the app matters to the story, so the
site always **shows** it: each feature carries a real app screenshot alongside the TUI, CLI and SDK views (a compact
switcher per feature, with screenshots for the app and the TUI and snippets for the CLI and SDK). No feature is shown
as text only, and none hides the app. The docs carry the details. The mockup's one-line text strip is a placeholder
until real screenshots exist; it's replaced in the site rework at the end (owner, 2026-11-09).

## Site structure (owner, 2026-11-09)

The home page is organised by the three pillars: the hero shows one example per pillar (Declare: a few lines of
`wisp.yml`; Run: a task streaming; Track: `wisp blame`), never two examples of the same pillar. Then one section per
pillar, in order, each with the four-ways line, then the close: "Declare. Run. Track."

## Report vs transcript (owner, 2026-11-09)

"You read a report, not a transcript" is no longer a headline. The report is a view: the apps open on it by default,
and the full transcript is one click away (and always kept, ADR-0033). Mention it inside the Run section's details or
the docs as an option, not as a pillar or a hero claim.

## References the owner likes (2026-11-09): warp.dev, openclaw.ai, herdr.dev

What each does well, and what we take:
- **warp.dev:** a hero that looks like a live dashboard (a block-character grid of task states with a running
  counter: "224 tasks · 1,422 PRs shipped"), an annotated YAML panel with callouts, figure labels
  ("[ fig. 1 — the factory ]"), proof as measured outcomes (cost per PR, benchmarks) rather than quotes, and a
  "use it everywhere" section (factories, terminal, CLI). Terse, technical, mostly lowercase.
  → Take: the live hero (wisp's tasks running across your machines, streaming), the annotated `.wisp/` panel with
  callouts, figure labels, numbers as proof, and the App · TUI · CLI · SDK section.
- **openclaw.ai:** personality through a mascot and ASCII art, an install block right under the hero, testimonials as
  X-post cards, "What people are building" (community showcase), "works with everything" tags, links to docs,
  Discord and GitHub everywhere. Playful but confident.
  → Take: **wisp's spirit** as the mascot (the site already has `spirit.js`), a quick-start terminal block, a
  community gallery of formulas and modules people share (ties to wisp Cloud sharing, ADR-0038), real posts as
  social proof, and the harness and integration tag cloud.
- **herdr.dev:** a hero mosaic of real screenshots, a README-style explainer with a numbered anchor menu, copyable
  install commands per OS, and terminal snippets showing agents running agents.
  → Take: real app and TUI screenshots (the site rule: the app is always shown), the README-style pillar sections,
  and per-OS install blocks.

**Direction for the v2 site:** a live, technical hero (tasks streaming across machines, Warp-style), wisp's spirit
for personality (OpenClaw-style), real screenshots and a README-style flow through Declare · Run · Track
(Herdr-style), proof in numbers, and a community gallery. It's built in the site rework, after the docs foundation.

## ⚠️ Competitive note: Warp now says "software factories as code"

warp.dev's hero is "Open infrastructure for cloud software factories", with "Your software factory, defined in code"
and a `factory.yaml`: "factories as code, any model or harness". So **"as code" alone is no longer ours**, and the
uniqueness claim in this doc must change before launch. Where wisp is still different (to verify with the researcher):
- **Track:** the repo carries every task, with its transcript, next to the code it wrote. `wisp blame`, `resume`
  and `.wisp/` are the differentiator to lead with.
- **Open source and yours:** MIT, local-first, your own machines and accounts, $0 on top. Warp's factories are
  cloud infrastructure, with early access and enterprise sales.
- **Every frontend equal:** app, TUI, CLI and SDK.

Action: the researcher (Moris) compares wisp v2 with Warp's factories, OpenClaw and Herdr before any claim ships,
and the hero is re-checked against it.
