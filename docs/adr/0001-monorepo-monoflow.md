# ADR-0001: Monorepo on npm workspaces, handled by monoflow

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 was one Node package with `server/`, `web/` and `grid/` side by side. Nothing stopped a feature from reaching into another, and CI could only run everything.

## Decision

- The repo is an **npm workspaces** monorepo. Its packages follow the plugin boundaries (`packages/*`, `plugins/*/{api,host,ui}`, `apps/*`). That gives the graph the edges plan §6.11 requires: other plugins depend on a plugin's `api` only.
- **monoflow** handles it: the dependency graph (`graph impact`, `graph query`), affected-only verification (`verify --affected`), checkpoints and its results cache. Every package has `test` and `typecheck` scripts so `monoflow verify` runs them. It is the inner-loop gate for people and agents.
- `.agents/monoflow.config.json` keeps `packages` empty, so the graph is discovered from the workspaces on every run and never goes stale.
- **Turned off** (plan §9.4.3): the shield git hooks (they live in the `.git` that every worktree and the owner's main checkout share, and block raw `git commit`), the `git` shim, monoflow's worktrees, `start/ship`, and its "never use raw git" rules. `tools/setup-monoflow.ts` installs monoflow without them.
- PR CI runs `monoflow verify --all` and records `verify --affected` in report-only mode until **gate G14** passes (the last 200 merged PRs: the affected set caught every failing package, with no misses).
- npm, not pnpm: the repo already used npm, and monoflow reads `workspaces`.

## Consequences

Every change can be scoped by the graph. A file outside every package (`docs/`, `design/`) counts as nothing affected until monoflow's global-inputs fix lands, so PR CI keeps the full run (G14). Workspaces are a development boundary only: the published package bundles them (ADR-0002).
