# wisp.resources engine: formulas (YAML/JSON/TOML, include, profiles, refs), plan/apply/export, trust (+5 more)

Backfilled from git history: no transcript was kept for this job.

## feat(v2 resources): wisp.resources engine: formulas (YAML/JSON/TOML, include, profiles, refs), plan/apply/export, trust

`08bc2daf5c`

## feat(v2 workflows): workflow DAGs of task specs (needs, if, matrix, outputs, retries, budget)

`fd437de7d0`

## feat(v2 runtime): task specs, formula snapshots, reruns under other formulas, agent profiles

`84688232cd`

## feat(v2 kinds): setting, agent, crew, task, workflow, router resource kinds

`ba93a4e8eb`

## feat(v2 cli): apply, diff, validate, schema, export, run -f, rerun --formula, task spec/export/formula

`cf0ff74976`

## chore(v2): rust-resource-kinds check, ADR-0030 dependencies, docs

`1ae1256d9b`

## Files

- `CHANGELOG.md`
- `Cargo.lock`
- `Cargo.toml`
- `crates/wisp/Cargo.toml`
- `crates/wisp/src/attach.rs`
- `crates/wisp/src/code.rs`
- `crates/wisp/src/groups.rs`
- `crates/wisp/src/main.rs`
- `crates/wisp/src/tasks_cli.rs`
- `crates/wisp/tests/serve_code.rs`
- `docs/adr/0030-formula-crates.md`
- `docs/v1-bugs-fixed.md`
- `plugins/automations/api/Cargo.toml`
- `plugins/automations/api/src/lib.rs`
- `plugins/automations/api/src/tasks.rs`
- `plugins/automations/host/Cargo.toml`
- `plugins/automations/host/src/lib.rs`
- `plugins/automations/host/wisp-plugin.json`
- `plugins/crew/api/Cargo.toml`
- `plugins/crew/api/src/lib.rs`
- `plugins/crew/api/src/spec.rs`
- `plugins/crew/core/src/member.rs`
- `plugins/crew/core/src/transfer.rs`
- `plugins/crew/host/Cargo.toml`
- `plugins/crew/host/src/jobs.rs`
- `plugins/crew/host/src/kind.rs`
- `plugins/crew/host/src/lib.rs`
- `plugins/crew/host/wisp-plugin.json`
- `plugins/resources/README.md`
- `plugins/resources/api/Cargo.toml`
- `plugins/resources/api/src/adapters.rs`
- `plugins/resources/api/src/lib.rs`
- `plugins/resources/core/Cargo.toml`
- `plugins/resources/core/src/export.rs`
- `plugins/resources/core/src/formula.rs`
- `plugins/resources/core/src/lib.rs`
- `plugins/resources/core/src/plan.rs`
- `plugins/resources/core/src/schema.rs`
- `plugins/resources/core/tests/goldens.rs`
- `plugins/resources/core/tests/goldens/create-update-unchanged.json`
- `plugins/resources/core/tests/goldens/export-applied-back.json`
- `plugins/resources/core/tests/goldens/nested-fields.json`
- `plugins/resources/core/tests/goldens/prune.json`
- `plugins/resources/core/tests/goldens/settings-map.json`
- `plugins/resources/core/tests/plans.json`
- `plugins/resources/host/Cargo.toml`
- `plugins/resources/host/src/lib.rs`
- `plugins/resources/host/wisp-plugin.json`
- `plugins/resources/pending-kinds.txt`
- `plugins/router/host/Cargo.toml`
- `plugins/router/host/src/kind.rs`
- `plugins/router/host/src/lib.rs`
- `plugins/runtime/api/Cargo.toml`
- `plugins/runtime/api/bindings/runtime/AgentSpec.ts`
- `plugins/runtime/api/bindings/runtime/Base.ts`
- `plugins/runtime/api/bindings/runtime/HashArgs.ts`
- `plugins/runtime/api/bindings/runtime/Lineage.ts`
- `plugins/runtime/api/bindings/runtime/NameArgs.ts`
- `plugins/runtime/api/bindings/runtime/Profile.ts`
- `plugins/runtime/api/bindings/runtime/Snapshot.ts`
- `plugins/runtime/api/bindings/runtime/StartArgs.ts`
- `plugins/runtime/api/bindings/runtime/TaskSpec.ts`
- `plugins/runtime/api/src/commands/mod.rs`
- `plugins/runtime/api/src/commands/tasks.rs`
- `plugins/runtime/api/src/lib.rs`
- `plugins/runtime/api/src/spec.rs`
- `plugins/runtime/host/Cargo.toml`
- `plugins/runtime/host/src/lib.rs`
- `plugins/runtime/host/src/plugin.rs`
- `plugins/runtime/host/src/schema.rs`
- `plugins/runtime/host/src/specs.rs`
- `plugins/runtime/host/wisp-plugin.json`
- `plugins/settings/host/Cargo.toml`
- `plugins/settings/host/src/kind.rs`
- `plugins/settings/host/src/lib.rs`
- `plugins/workflows/README.md`
- `plugins/workflows/api/Cargo.toml`
- `plugins/workflows/api/src/lib.rs`
- `plugins/workflows/core/Cargo.toml`
- `plugins/workflows/core/src/expr.rs`
- `plugins/workflows/core/src/lib.rs`
- `plugins/workflows/host/Cargo.toml`
- `plugins/workflows/host/src/lib.rs`
- `plugins/workflows/host/wisp-plugin.json`
- `tools/check/rules/rust.ts`
