# API keys map to custom: capability sets at the edge (+7 more)

Backfilled from git history: no transcript was kept for this job.

## fix(v2 runtime): setup runs only in a fresh worktree and a failure holds the turn; overlay secrets in memory; projectRun

`fa14fc81df`

## feat(v2 api): API keys map to custom: capability sets at the edge

`b53b876130`

## feat(v2 machines): machines host: peers over v2 sync, ssh + loopback transports, machine kind

`4f08673265`

## feat(v2 channels): channels hub + ntfy; channel and notification kinds act

`67b287c39b`

## feat(v2 goal): goal host: judges, votes, rounds, stalls

`86e195924f`

## feat(v2 kinds): pipeline atLimit/bestOf/judge, harness install, webhook triggers

`d8f316fe45`

## test(v2): serve e2e for kinds, channels, machines

`128ada71f8`

## chore(v2): remaining host changes

`a7b4f76478`

## Files

- `Cargo.lock`
- `crates/wisp-api/src/auth.rs`
- `crates/wisp-api/src/backend.rs`
- `crates/wisp-api/src/edge.rs`
- `crates/wisp-kernel/src/caps.rs`
- `crates/wisp-kernel/src/host.rs`
- `crates/wisp-kernel/src/kernel_api.rs`
- `crates/wisp/Cargo.toml`
- `crates/wisp/src/groups.rs`
- `crates/wisp/tests/serve_channels.rs`
- `crates/wisp/tests/serve_kinds.rs`
- `crates/wisp/tests/serve_machines.rs`
- `plugins/accounts/api/bindings/accounts/InstallArgs.ts`
- `plugins/accounts/api/src/commands.rs`
- `plugins/accounts/host/src/ops.rs`
- `plugins/automations/host/Cargo.toml`
- `plugins/automations/host/src/trigger.rs`
- `plugins/channels/host/Cargo.toml`
- `plugins/channels/host/src/hub.rs`
- `plugins/channels/host/src/kinds.rs`
- `plugins/channels/host/src/lib.rs`
- `plugins/channels/host/wisp-plugin.json`
- `plugins/connectors/host/src/kinds.rs`
- `plugins/connectors/host/wisp-plugin.json`
- `plugins/goal/api/src/lib.rs`
- `plugins/goal/core/src/lib.rs`
- `plugins/goal/host/Cargo.toml`
- `plugins/goal/host/src/kinds.rs`
- `plugins/goal/host/src/lib.rs`
- `plugins/goal/host/wisp-plugin.json`
- `plugins/machine/host/src/kinds.rs`
- `plugins/machine/host/wisp-plugin.json`
- `plugins/machines/api/src/commands.rs`
- `plugins/machines/api/src/ids.rs`
- `plugins/machines/api/src/lib.rs`
- `plugins/machines/api/src/rows.rs`
- `plugins/machines/api/src/transport.rs`
- `plugins/machines/core/bootstrap.sh`
- `plugins/machines/core/src/bootstrap.rs`
- `plugins/machines/core/src/lib.rs`
- `plugins/machines/core/src/mirror.rs`
- `plugins/machines/core/src/mirror_tests.rs`
- `plugins/machines/core/src/negotiate.rs`
- `plugins/machines/core/src/route.rs`
- `plugins/machines/core/src/view.rs`
- `plugins/machines/core/src/view_tests.rs`
- `plugins/machines/host/Cargo.toml`
- `plugins/machines/host/src/commands.rs`
- `plugins/machines/host/src/error.rs`
- `plugins/machines/host/src/http.rs`
- `plugins/machines/host/src/letin.rs`
- `plugins/machines/host/src/lib.rs`
- `plugins/machines/host/src/link.rs`
- `plugins/machines/host/src/loopback.rs`
- `plugins/machines/host/src/manager.rs`
- `plugins/machines/host/src/service.rs`
- `plugins/machines/host/src/ssh.rs`
- `plugins/machines/host/src/state.rs`
- `plugins/machines/host/src/store.rs`
- `plugins/machines/host/src/sys.rs`
- `plugins/machines/host/wisp-plugin.json`
- `plugins/ntfy/host/Cargo.toml`
- `plugins/ntfy/host/src/lib.rs`
- `plugins/resources/host/src/capability.rs`
- `plugins/router/host/src/pipeline.rs`
- `plugins/router/host/wisp-plugin.json`
- `plugins/runtime/api/bindings/runtime/ProjectRunArgs.ts`
- `plugins/runtime/api/src/commands/mod.rs`
- `plugins/runtime/api/src/commands/more.rs`
- `plugins/runtime/host/src/kinds.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/runtime/host/src/run.rs`
- `plugins/runtime/host/src/runtime.rs`
- `plugins/runtime/host/src/specs.rs`
- `plugins/runtime/host/wisp-plugin.json`
