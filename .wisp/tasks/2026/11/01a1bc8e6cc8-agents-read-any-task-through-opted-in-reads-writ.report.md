# agents read any task through opted-in reads; writes stay scoped (+5 more)

Backfilled from git history: no transcript was kept for this job.

## feat(v2 kernel): agents read any task through opted-in reads; writes stay scoped

`ceabe0138b`

## feat(v2 later): times stored UTC, written in the user's zone (jiff, ADR-0025)

`33d7e449f8`

## feat(v2 terminal, lsp): streaming responses, PTY terminals with the flow machine, language servers

`93c186b4b3`

## fix(v2 settings): settings are saved through the store; v1's /config

`b098224644`

## test(v2): serve e2e for terminal, lsp, settings

`6de55c7431`

## chore(v2): store write_detached and settings ctx helpers

`95f3d5c100`

## Files

- `Cargo.lock`
- `Cargo.toml`
- `crates/wisp-kernel/src/activate.rs`
- `crates/wisp-kernel/src/dispatch.rs`
- `crates/wisp-kernel/src/exec/mod.rs`
- `crates/wisp-kernel/src/host.rs`
- `crates/wisp-kernel/src/http.rs`
- `crates/wisp-kernel/src/kernel_api.rs`
- `crates/wisp-kernel/src/lib.rs`
- `crates/wisp-kernel/src/reg.rs`
- `crates/wisp-kernel/src/scope.rs`
- `crates/wisp-store/src/thread.rs`
- `crates/wisp-testkit/tests/scope.rs`
- `crates/wisp/src/main.rs`
- `crates/wisp/src/serve.rs`
- `crates/wisp/src/settings_store.rs`
- `crates/wisp/tests/fixtures/fake_lsp.py`
- `crates/wisp/tests/serve_later.rs`
- `crates/wisp/tests/serve_lsp.rs`
- `crates/wisp/tests/serve_settings.rs`
- `crates/wisp/tests/serve_task.rs`
- `crates/wisp/tests/serve_terminal.rs`
- `docs/adr/0025-jiff-for-time-zones.md`
- `docs/adr/README.md`
- `plugins/later/api/bindings/later/ZoneArgs.ts`
- `plugins/later/api/src/commands.rs`
- `plugins/later/host/Cargo.toml`
- `plugins/later/host/src/lib.rs`
- `plugins/later/host/src/store.rs`
- `plugins/later/host/wisp-plugin.json`
- `plugins/lsp/README.md`
- `plugins/lsp/host/src/lib.rs`
- `plugins/lsp/host/wisp-plugin.json`
- `plugins/runtime/api/bindings/runtime/AgentSessionArgs.ts`
- `plugins/runtime/api/bindings/runtime/AgentSessionsArgs.ts`
- `plugins/runtime/api/bindings/runtime/AgentText.ts`
- `plugins/runtime/api/src/commands/mod.rs`
- `plugins/runtime/api/src/commands/more.rs`
- `plugins/runtime/host/src/lib.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/runtime/host/src/reads.rs`
- `plugins/runtime/host/wisp-plugin.json`
- `plugins/settings/README.md`
- `plugins/settings/api/Cargo.toml`
- `plugins/settings/api/src/lib.rs`
- `plugins/settings/host/Cargo.toml`
- `plugins/settings/host/src/lib.rs`
- `plugins/settings/host/wisp-plugin.json`
- `plugins/terminal/README.md`
- `plugins/terminal/host/src/lib.rs`
- `plugins/terminal/host/src/registry.rs`
- `plugins/terminal/host/wisp-plugin.json`
