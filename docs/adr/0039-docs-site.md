# ADR-0039: docs.trywisp.dev, a full documentation site built from the repo

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "a big focus on a new docs.trywisp.dev; we now provide tools that must be explained in every
  aspect; look at how big similar projects do their docs."

## What we take from the best

- **Terraform / HashiCorp Developer:** tutorials separate from docs; a *language* section (syntax, expressions,
  modules, functions), a *CLI* section with one page per command, and a *registry* of providers and modules.
  wisp maps onto it: formula language, CLI, and the catalogue of kinds, harnesses and modules.
- **Stripe and Supabase:** reference pages with **language tabs that stay chosen** across pages, copyable runnable
  snippets, and an API reference generated from the source. wisp's version: **App · TUI · CLI · SDK tabs** on every
  how-to (the site rule), and TypeScript/Python tabs in SDK pages.
- **Kubernetes and Docker:** a concepts section that explains the model (objects, controllers, state) before the
  how-to. wisp's version: kernel, plugins, resources, tasks, peers.
- **Diátaxis** (used by Django and Canonical, among others): four kinds of page that never mix. **Tutorials**
  (learn by doing), **How-to guides** (get a thing done), **Reference** (look it up), **Explanation** (understand
  why).
- **Docs for agents too (llms.txt, markdown per page):** agents are wisp's users. Every page is available as
  plain markdown (`/page.md`), there's an `/llms.txt` index and an `/llms-full.txt`, and each page has "Copy for
  your agent".

## Information architecture

```
Get started        install (npm, brew, app, Cloud) · your first task · your first .wisp/ · tour of the app/TUI/CLI
Concepts           Declare · Run · Track · tasks (spec + history) · agents and harnesses · crew · machines and peers ·
                   formulas, resources and modules · workflows · plugins · permissions · sync · the .wisp/ folder ·
                   wisp Cloud and the grid
Guides (how-to)    by pillar, each with App · TUI · CLI · SDK tabs:
                   Declare: agents, crew, skills, MCP, tools, rules, workflows, variables, modules, workspaces, sharing a setup
                   Run: run a task, follow up, queue, goals, compare, schedule, machines, cloud, channels (Slack, Telegram, …),
                   budgets, Auto, terminal context
                   Track: .wisp/ history, blame, resume, rerun, share tasks, adopt outside sessions, review agent-written PRs
Reference          (generated from the code; never written by hand)
                   CLI (every command and flag) · formula language (syntax, expressions, functions) · every resource kind
                   (schema, fields, examples) · SDK (TypeScript, Python) · MCP tools · answer blocks · settings ·
                   environment variables · error codes · plugin manifest and extension points · sync protocol · HTTP API
Integrations       one page per harness (Claude Code, Codex, Cursor, …), per channel, MCP connectors, editors, CI
Cookbook           real formulas: review team, nightly dependency bot, release check, fan-out audit, support triage …
Build plugins      tutorial, manifest, extension points, UI plugins, exec tier, testing, publishing
Self-host          wisp Grid: install, config, sign-in providers, backups (Litestream), upgrades
Migrate from v1    what changed, `wisp import`, the feature map
Changelog
```

## How it's built

- **Source in the repo:** `docs/site/` (markdown and MDX), next to the code, reviewed in the same PR as the feature.
  A feature isn't done until its pages exist (concept, how-to with all four tabs, reference generated).
- **Generator:** Astro Starlight in `apps/docs`: static, fast, built-in sidebar, Pagefind search (offline, no
  service), dark mode, tabs that sync across pages, and versioned docs per release. It's a dev-only dependency: none
  of it ships in the wisp binary. The kit's tokens are used so docs look like wisp.
- **Generated reference:** the CLI pages from the command catalogue (ADR-0022), the kinds from their JSON Schemas
  (ADR-0026/0028), the SDKs from their types, the MCP tools, blocks, settings, errors and manifest from the code.
  `tools/check` fails when generated pages are stale.
- **Examples are tested:** every formula snippet is validated (`wisp validate`), every CLI example runs in CI against
  `wisp serve` with the fake agent, every SDK snippet type-checks, and every screenshot is produced by a QA script
  from the real app, so docs never show a UI that no longer exists.
- **Quality bar:** every page passes the house writing rules (`design/copy.md`), has an owner plugin, a "last
  verified" version, and an "Edit this page" link. Broken links fail CI.
- **Hosting:** docs.trywisp.dev, deployed from `main` by the pages workflow, with a preview per PR.

## Consequences

- The docs are a large, ongoing piece of work owned by marketing (writing), the coder (generated reference,
  tests, tooling) and the lead (review). It starts once the CLI, formula language and kinds are stable, and grows
  with every feature after that.
- trywisp.dev (the marketing site) links into the docs and stops carrying guides itself.
