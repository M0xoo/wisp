# agent tokens scoped to their task and its children, checked once for every plugin (+5 more)

Backfilled from git history: no transcript was kept for this job.

## feat(v2 kernel): agent tokens scoped to their task and its children, checked once for every plugin

`25529c2dc5`

## feat(v2 accounts): keys, install, recheck, live limits, agy login, v1 routes

`5e2520092d`

## feat(v2 later, budget): scheduler, held work past the stop line

`12ba708f80`

## feat(v2 telemetry): pipeline with sinks; wisp.posthog sends v1's 52 events (ADR-0021)

`fe34db8766`

## test(v2): serve e2e for accounts, budget hold, later

`258506a6c9`

## chore(v2): runtime api and harness additions for scope, npm_package, sign_out

`8d5eb6f4b7`

## Files

- `Cargo.lock`
- `Cargo.toml`
- `crates/wisp-api/src/backend.rs`
- `crates/wisp-kernel/src/activate.rs`
- `crates/wisp-kernel/src/dispatch.rs`
- `crates/wisp-kernel/src/exec/mod.rs`
- `crates/wisp-kernel/src/host.rs`
- `crates/wisp-kernel/src/lib.rs`
- `crates/wisp-kernel/src/reg.rs`
- `crates/wisp-kernel/src/routes.rs`
- `crates/wisp-kernel/src/scope.rs`
- `crates/wisp-testkit/fixtures/fake_agent.rs`
- `crates/wisp-testkit/tests/scope.rs`
- `crates/wisp/Cargo.toml`
- `crates/wisp/src/groups.rs`
- `crates/wisp/tests/serve_accounts.rs`
- `crates/wisp/tests/serve_budget.rs`
- `crates/wisp/tests/serve_later.rs`
- `crates/wisp/tests/serve_task.rs`
- `crates/wisp/tests/serve_telemetry.rs`
- `plugins/accounts/README.md`
- `plugins/accounts/api/bindings/accounts/KeySetArgs.ts`
- `plugins/accounts/api/bindings/accounts/KeyTested.ts`
- `plugins/accounts/api/bindings/accounts/ProviderArgs.ts`
- `plugins/accounts/api/src/commands.rs`
- `plugins/accounts/host/src/keys.rs`
- `plugins/accounts/host/src/lib.rs`
- `plugins/accounts/host/src/ops.rs`
- `plugins/accounts/host/src/routes.rs`
- `plugins/accounts/host/src/signin.rs`
- `plugins/accounts/host/src/sys.rs`
- `plugins/accounts/host/wisp-plugin.json`
- `plugins/antigravity/host/src/lib.rs`
- `plugins/budget/README.md`
- `plugins/budget/api/bindings/budget/StopArgs.ts`
- `plugins/budget/api/src/commands.rs`
- `plugins/budget/host/Cargo.toml`
- `plugins/budget/host/src/lib.rs`
- `plugins/budget/host/src/store.rs`
- `plugins/budget/host/wisp-plugin.json`
- `plugins/codex/host/src/lib.rs`
- `plugins/later/README.md`
- `plugins/later/host/Cargo.toml`
- `plugins/later/host/src/lib.rs`
- `plugins/later/host/src/store.rs`
- `plugins/later/host/wisp-plugin.json`
- `plugins/opencode/host/src/lib.rs`
- `plugins/posthog/README.md`
- `plugins/posthog/core/Cargo.toml`
- `plugins/posthog/core/src/lib.rs`
- `plugins/posthog/host/Cargo.toml`
- `plugins/posthog/host/src/lib.rs`
- `plugins/posthog/host/wisp-plugin.json`
- `plugins/runtime/api/src/commands/mod.rs`
- `plugins/runtime/api/src/harness/mod.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/telemetry/README.md`
- `plugins/telemetry/api/Cargo.toml`
- `plugins/telemetry/api/src/catalogue.json`
- `plugins/telemetry/api/src/lib.rs`
- `plugins/telemetry/api/tests/catalogue.rs`
- `plugins/telemetry/api/tests/fixtures/v1-events.json`
- `plugins/telemetry/core/src/env.rs`
- `plugins/telemetry/core/tests/goldens/opt-outs.json`
- `plugins/telemetry/core/tests/telemetry.rs`
- `plugins/telemetry/host/Cargo.toml`
- `plugins/telemetry/host/src/lib.rs`
- `plugins/telemetry/host/tests/sinks.rs`
- `plugins/telemetry/host/wisp-plugin.json`
