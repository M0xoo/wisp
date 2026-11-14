---
name: monoflow
description: >-
  Use before changing a contract (an api/ package, @wisp/protocol, @wisp/kernel) and after every change
  in this monorepo, to see which packages it reaches and to verify only those.
---

# monoflow in wisp (ADR-0001)

The binary is `.agents/bin/monoflow` (installed by `monoflow init`, not committed). The graph comes from
npm workspaces, discovered on every run: `.agents/monoflow.config.json` keeps `packages` empty on purpose,
so a new package needs no config edit.

1. **Before changing a contract:** `.agents/bin/monoflow graph impact <file>` lists the owning package and
   every package that depends on it. A change to `plugins/<x>/api` reaches its consumers; a change to
   `plugins/<x>/host` reaches only `<x>` and `apps/server`. That is the point of the api/host split.
2. **After the change:** `.agents/bin/monoflow verify --affected` runs `test` (and `lint`, `typecheck` where a
   package has them) for the affected packages only. Then run `npm run check` once, because the structure
   rules span every package.
3. **Before you hand back:** `npm run verify` (everything). PR CI runs the full suite until gate G14 passes.

Turned off for wisp, on purpose (plan §9.4.3): the git shield hooks, the `git` shim, monoflow's own
worktrees, `monoflow start/ship`, and its "never use raw git, never grep" rules. Commits, branches, PRs and
worktrees stay with git, `gh` and wisp. If `monoflow init` is ever run again, remove what it installs in
`.git/hooks/`, `.agents/bin/git`, `.claude/settings.json`, `.opencode/` and the block it adds to AGENTS.md.

**In a worktree shared by several agents** (wisp's crew and subagents work this way): never `checkpoint revert`,
`commit`, `outer` or `ship`. `checkpoint revert` is `git read-tree -u --reset` and removes every staged file
that isn't in the checkpoint, including other agents' new work; `commit` starts the outer loop, which did the
same on 2026-11-07. Graph, verify and `checkpoint save` are safe.
