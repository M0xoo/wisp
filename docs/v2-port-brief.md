# wisp v2: brief for the agents porting v1's server into plugins

Read `docs/v2-team-brief.md` first; everything there applies. This page adds what the port needs.

## What "port" means

v2 is v1 with the new architecture. You move v1 behaviour into plugins, in TypeScript, **behaviour for
behaviour**: every edge case v1 handles, and every v1 test for your area, comes along (`test/*.test.js` →
`plugins/<name>/host/test/*.test.ts`). The v1 tests are the parity oracle (plan §9.3 step 1). Drop a v1 test
only when its subject is gone in v2 (for example the unfiltered broadcast), and list each one you drop, with
why, in your report.

## Shape of each plugin you write

```
plugins/<name>/
  api/   package.json "@wisp-plugin/<name>-api", src/index.ts: commands, events, hooks, points, services, row types
  host/  package.json "@wisp-plugin/<name>", wisp-plugin.json, src/index.ts (default export: definePlugin), src/*.ts, test/*.test.ts
```

- Copy `package.json` and `tsconfig.json` from `packages/protocol` and adapt them. Scripts: `test`
  (`node --test --test-reporter=dot "test/**/*.test.ts"`) and `typecheck` (`tsc -p tsconfig.json`).
  Dependencies are workspace names with `"*"`. After you add a package, run `npm install --no-audit
  --no-fund` at the root so it gets linked (retry once if npm says the lock is busy).
- `host/src/index.ts`: `export default definePlugin({ id: 'wisp.<name>', setup(ctx) { … } })`, with
  `definePlugin` from `@wisp/kernel`. If the kernel package doesn't export it yet (it's being built in
  parallel), use `const definePlugin = <T>(d: T) => d` locally and say so.
- Contracts you code against: `packages/kernel/src/contract.ts` (PluginContext, commands, events,
  interceptors, services, scopes), `packages/kernel/src/services.ts` (proc, http, secrets, notify, net,
  paths), `plugins/runtime/api/src/index.ts` (tasks, turns, harness point, summary/prompt/block points,
  runtime commands, events and hooks). Read them before you start.
- **The store:** `@wisp/store` (packages/store, being built in parallel; read its src/index.ts for the
  API). Your tables get your prefix and your migrations. All writes go through `store.tx`.
- **v1's HTTP API stays, as thin adapters.** Every v1 route in your area is registered through the `http`
  service (`ctx.service<HttpService>('http').route(method, pattern, handler, { permission })`) with the
  same method, path, request and response shape as v1, calling your commands. v1 clients (older phone
  apps, the SDK `wisp-agents/client`, MCP tools, other machines on v1) keep working, and v1's route tests
  port almost 1:1. Every route names a permission. Add the route to the plugin's `openapi` export
  (`export const openapi = { '/path': { get: { summary } } }` in host/src/openapi.ts); the edge merges them.
- **No `app` object.** Where v1 calls `app.x.y()` across features, use the owner's command, event, hook,
  point or service from its `api` package. If the owner is another agent's plugin and its `api` lacks what
  you need, add the declaration to *their* `api/src/index.ts` (adding is allowed, don't change what's
  there) and list it in your report.
- Child processes only through the `proc` service, HTTP out through `net`, files through node:fs
  (async; `*Sync` only at startup or in migrations). Timers only through `ctx.scope`.
- Settings v1 kept in `config.defaults.<key>` become `contributes.settings` in the manifest (same key
  names, so the importer maps them), and are read through `ctx.settings`.

## Ownership (touch only your plugins)

| Agent | Plugins (plugins/<name>) | v1 sources |
|---|---|---|
| runtime | runtime (+ the importer of v1 sessions) | runner.js, store.js, routes/sessions.js, services/launch.js, render.js, protocol.js, welcome.js, mentions.js, search.js, handoff.js, stage.js, lean.js, refusal.js, hunks.js, runs.js, quick.js, btw.js, side.js, side-gate.js, subagents.js, conductor.js, pipeline.js, checkpoint.js, judge.js, bundle.js, services/fork.js, move.js, places.js, relay.js, overlaps.js, send-once.js, tui.js |
| harness | claude, codex, cursor, opencode, copilot, grok, antigravity (modules of runtime), accounts | adapters/*, accounts.js, agent-login.js, harness-watch.js, harness-disk.js, live-limits.js, usage.js, allowance.js, opencode-gate.js, env-mask.js |
| git | git, worktrees, ship, issues, review | git.js, worktree-setup.js, secret-scan.js, services/worktrees.js, done-folders.js, ship.js, review.js, issues.js, project-trust.js, routes/worktrees.js, routes/ship.js, routes/issues.js, routes/workspace.js |
| terminal | terminal, lsp, machine (This Mac) | pty.js, terminal.js, proc.js (→ kernel proc service impl, in apps/server/src/services/proc.ts: coordinate through your report), lsp.js, machine.js, load.js, guard.js, routes/machine.js, routes/lsp.js, watch.js |
| machines | machines, grid-client | machines.js, machines/*, shq.js, routes/machines.js, routes/proxy.js, grid-client.js, grid-tunnel.js, services/cloud.js, computer.js, sandbox.js, api-keys.js, publish.js, share.js, routes/cloud.js |
| crew | crew, goal, later, budget, router (Auto), automations, learn | crew.js, crew-tools.js, crew-share.js, routes/crew.js, goal.js, goal-runs.js, later.js, budget.js, router.js, router-priors.json, priors-build.js, services/auto.js, routes/auto.js, triggers.js, recipes.js, hooks.js, routes/hooks.js, services/webhooks.js, routes/automations.js, preferences.js |
| channels | channels, telegram, slack, discord, github, email, ntfy, mcp, connectors | channels/*, remote.js, services/phone.js, routes/channels.js, mcp-wisp.js, mcp-ask.js, mcp-connector.js, connectors.js, connector-auth.js, routes/connectors.js, capped.js (→ capability set data) |
| edge | apps/server, plugins stuff, plugins (ex-spells), telemetry, update, settings | index.js, http/*, routes/meta.js, control.js, internal.js, settings.js, stuff.js, uploads.js, spells.js, openapi.js, agent-token.js, paths.js, util.js, check.js, scout.js, secrets.js, spells*.js, spell-guide.js, pane-guide.js, starters/, services/stuff.js, apps.js, app-db*.js, app-scan.js, uploads.js, spell-hooks.js, telemetry.js, feedback.js, install.js, update.js, bin/wisp.js, server/client.js (SDK) |
| grid | apps/grid (the port of grid/) | grid/* (boxd stays Node built-ins only and imports nothing from wisp) |

If a v1 file you need sits in another agent's row, read it, but don't port it.

## Done means

- `.agents/bin/monoflow verify --package=<each of your packages>` passes.
- Your report gives, per plugin: commands, events, hooks, points, routes (with permissions), tables, the
  v1 tests ported (count) and the ones dropped (with why), benches for hot paths, and every declaration you
  added to someone else's `api`.
