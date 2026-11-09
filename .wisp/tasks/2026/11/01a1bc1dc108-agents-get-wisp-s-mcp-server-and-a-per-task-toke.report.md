# agents get wisp's MCP server and a per-task token (+5 more)

Backfilled from git history: no transcript was kept for this job.

## refactor(v2): router, crew and My Stuff rows into wisp-store with v1 importers (ADR-0020)

`02640e14ce`

## fix(v2 runtime): asks survive restart, task_lock, ask/approval/delegate/rerun parity with v1; follow-ups interrupt by default

`be27c3f62f`

## feat(v2 mcp): agents get wisp's MCP server and a per-task token

`8789124902`

## fix(v2 ui): unread titles, 320 pill and footer, launcher offset; feedback gate submits and checks rollback

`ec19e51775`

## test(v2): serve e2e (restart mid-ask, agent side)

`6240d2cccc`

## chore(v2): kernel/host additions for agent access (spawn, agent_access)

`b6d45e3900`

## Files

- `Cargo.lock`
- `crates/wisp/Cargo.toml`
- `crates/wisp/src/serve.rs`
- `crates/wisp/tests/serve_task.rs`
- `docs/adr/0020-per-app-sqlite.md`
- `docs/adr/README.md`
- `packages/ui/src/css/app-stack.css`
- `plugins/crew/host/Cargo.toml`
- `plugins/crew/host/src/jobs.rs`
- `plugins/crew/host/src/lib.rs`
- `plugins/crew/host/src/store.rs`
- `plugins/crew/host/wisp-plugin.json`
- `plugins/mcp/host/src/run.rs`
- `plugins/router/core/src/state.rs`
- `plugins/router/host/Cargo.toml`
- `plugins/router/host/src/lib.rs`
- `plugins/router/host/src/store.rs`
- `plugins/router/host/wisp-plugin.json`
- `plugins/runtime/api/bindings/runtime/FollowUpArgs.ts`
- `plugins/runtime/api/bindings/runtime/SessionState.ts`
- `plugins/runtime/api/src/commands/tasks.rs`
- `plugins/runtime/api/src/model.rs`
- `plugins/runtime/api/src/points.rs`
- `plugins/runtime/host/src/drive.rs`
- `plugins/runtime/host/src/host.rs`
- `plugins/runtime/host/src/more.rs`
- `plugins/runtime/host/src/ops.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/runtime/host/src/run.rs`
- `plugins/runtime/host/src/runtime.rs`
- `plugins/runtime/host/src/side.rs`
- `plugins/stuff/host/Cargo.toml`
- `plugins/stuff/host/src/import.rs`
- `plugins/stuff/host/src/lib.rs`
- `plugins/stuff/host/src/ports.rs`
- `plugins/stuff/host/src/store.rs`
- `plugins/stuff/host/wisp-plugin.json`
- `qa/feedback.mjs`
- `qa/parity.mjs`
