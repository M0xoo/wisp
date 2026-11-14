# shared G6 golden replay, sync and stop steps (+6 more)

Backfilled from git history: no transcript was kept for this job.

## feat(v2 harness-kit): shared G6 golden replay, sync and stop steps

`7f92fe656e`

## feat(v2 runtime-api): Harness::program()

`171ce22e8e`

## fix(v2 security): exact-action approvals, agent tokens scoped to their own task, open questions cleared when the turn ends

`07f3280c61`

## feat(v2 harnesses): codex, opencode, cursor, copilot, grok, antigravity match v1 (65 goldens)

`d94eff6b9f`

## feat(v2 accounts): accounts plugin (14 commands, store, sign-in, harness-watch hold)

`9625f16f73`

## test(v2): serve e2e for every harness and accounts

`082e4769a8`

## chore(v2): harness hosts' shared driver tweaks

`28acef2476`

## Files

- `Cargo.lock`
- `crates/wisp-harness-kit/src/drive.rs`
- `crates/wisp-harness-kit/src/event.rs`
- `crates/wisp-harness-kit/src/golden.rs`
- `crates/wisp-harness-kit/src/lib.rs`
- `crates/wisp-harness-kit/src/parser.rs`
- `crates/wisp-harness-kit/src/protocol.rs`
- `crates/wisp-testkit/fixtures/fake_agent.rs`
- `crates/wisp/math.js`
- `crates/wisp/notes.txt`
- `crates/wisp/tests/common/mod.rs`
- `crates/wisp/tests/serve_accounts.rs`
- `crates/wisp/tests/serve_harness.rs`
- `crates/wisp/tests/serve_task.rs`
- `plugins/accounts/api/bindings/accounts/AccountArgs.ts`
- `plugins/accounts/api/bindings/accounts/AddArgs.ts`
- `plugins/accounts/api/bindings/accounts/AgentArgs.ts`
- `plugins/accounts/api/bindings/accounts/AskArgs.ts`
- `plugins/accounts/api/bindings/accounts/HarnessAccounts.ts`
- `plugins/accounts/api/bindings/accounts/LoginInputArgs.ts`
- `plugins/accounts/api/bindings/accounts/UpdateArgs.ts`
- `plugins/accounts/api/src/commands.rs`
- `plugins/accounts/api/src/lib.rs`
- `plugins/accounts/core/src/accounts.rs`
- `plugins/accounts/core/src/lib.rs`
- `plugins/accounts/core/src/login.rs`
- `plugins/accounts/core/src/watch.rs`
- `plugins/accounts/host/Cargo.toml`
- `plugins/accounts/host/src/folders.rs`
- `plugins/accounts/host/src/lib.rs`
- `plugins/accounts/host/src/ops.rs`
- `plugins/accounts/host/src/run.rs`
- `plugins/accounts/host/src/signin.rs`
- `plugins/accounts/host/src/store.rs`
- `plugins/accounts/host/wisp-plugin.json`
- `plugins/antigravity/core/src/lib.rs`
- `plugins/antigravity/core/tests/fixtures/auto.jsonl`
- `plugins/antigravity/core/tests/fixtures/auto.meta.json`
- `plugins/antigravity/core/tests/fixtures/auto.v1.json`
- `plugins/antigravity/core/tests/fixtures/fail.jsonl`
- `plugins/antigravity/core/tests/fixtures/fail.meta.json`
- `plugins/antigravity/core/tests/fixtures/fail.v1.json`
- `plugins/antigravity/core/tests/fixtures/resume.jsonl`
- `plugins/antigravity/core/tests/fixtures/resume.meta.json`
- `plugins/antigravity/core/tests/fixtures/resume.v1.json`
- `plugins/antigravity/core/tests/fixtures/stop.jsonl`
- `plugins/antigravity/core/tests/fixtures/stop.meta.json`
- `plugins/antigravity/core/tests/fixtures/stop.v1.json`
- `plugins/antigravity/core/tests/fixtures/turn.jsonl`
- `plugins/antigravity/core/tests/fixtures/turn.meta.json`
- `plugins/antigravity/core/tests/fixtures/turn.v1.json`
- `plugins/antigravity/core/tests/g6.rs`
- `plugins/antigravity/host/src/driver.rs`
- `plugins/antigravity/host/src/lib.rs`
- `plugins/claude/core/src/parser.rs`
- `plugins/claude/host/src/driver.rs`
- `plugins/claude/host/src/lib.rs`
- `plugins/codex/core/src/argv.rs`
- `plugins/codex/core/src/lib.rs`
- `plugins/codex/core/src/parser.rs`
- `plugins/codex/core/src/shell.rs`
- `plugins/codex/core/src/usage.rs`
- `plugins/codex/core/tests/g6.rs`
- `plugins/codex/host/src/driver.rs`
- `plugins/codex/host/src/launch.rs`
- `plugins/codex/host/src/lib.rs`
- `plugins/copilot/core/src/describe.rs`
- `plugins/copilot/core/src/lib.rs`
- `plugins/copilot/core/tests/g6.rs`
- `plugins/copilot/host/src/driver.rs`
- `plugins/copilot/host/src/lib.rs`
- `plugins/cursor/core/src/lib.rs`
- `plugins/cursor/core/tests/g6.rs`
- `plugins/cursor/host/src/driver.rs`
- `plugins/cursor/host/src/lib.rs`
- `plugins/grok/core/src/lib.rs`
- `plugins/grok/core/tests/fixtures/auto.v1.json`
- `plugins/grok/core/tests/fixtures/blocked.v1.json`
- `plugins/grok/core/tests/fixtures/fail.v1.json`
- `plugins/grok/core/tests/fixtures/resume.v1.json`
- `plugins/grok/core/tests/fixtures/stop.v1.json`
- `plugins/grok/core/tests/fixtures/turn.v1.json`
- `plugins/grok/core/tests/g6.rs`
- `plugins/grok/host/src/driver.rs`
- `plugins/grok/host/src/lib.rs`
- `plugins/opencode/core/src/argv.rs`
- `plugins/opencode/core/src/describe.rs`
- `plugins/opencode/core/src/lib.rs`
- `plugins/opencode/core/src/parser.rs`
- `plugins/opencode/core/tests/g6.rs`
- `plugins/opencode/host/src/driver.rs`
- `plugins/opencode/host/src/lib.rs`
- `plugins/runtime/api/src/harness/mod.rs`
- `plugins/runtime/host/src/finish.rs`
- `plugins/runtime/host/src/more.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/runtime/host/src/run.rs`
- `plugins/runtime/host/src/runtime.rs`
