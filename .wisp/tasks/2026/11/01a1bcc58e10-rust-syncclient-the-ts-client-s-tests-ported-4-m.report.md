# Rust SyncClient (the TS client's tests ported) (+4 more)

Backfilled from git history: no transcript was kept for this job.

## feat(v2 sync): Rust SyncClient (the TS client's tests ported)

`3852213533`

## feat(v2 kernel): the command catalogue with typed args

`c2a18fb48a`

## feat(v2 cli): wisp.cli plugin: generated verbs, help, completions, 29 terminal block renderers

`dbf1c5d926`

## feat(v2 cli): wisp "task" attached live with asks, reply box, Ctrl-C detach; attach, --watch

`a006983107`

## chore(v2): remaining CLI changes

`1fba1032b7`

## Files

- `Cargo.lock`
- `Cargo.toml`
- `crates/wisp-kernel/src/activate.rs`
- `crates/wisp-kernel/src/exec/mod.rs`
- `crates/wisp-kernel/src/host.rs`
- `crates/wisp-kernel/src/kernel_api.rs`
- `crates/wisp-kernel/src/lib.rs`
- `crates/wisp-kernel/src/reg.rs`
- `crates/wisp-sync/src/client.rs`
- `crates/wisp-sync/src/client_tests.rs`
- `crates/wisp-sync/src/lib.rs`
- `crates/wisp/Cargo.toml`
- `crates/wisp/src/args.rs`
- `crates/wisp/src/attach.rs`
- `crates/wisp/src/cli.rs`
- `crates/wisp/src/client.rs`
- `crates/wisp/src/groups.rs`
- `crates/wisp/src/main.rs`
- `crates/wisp/src/scripted.rs`
- `crates/wisp/tests/serve_cli.rs`
- `plugins/accounts/api/src/commands.rs`
- `plugins/automations/api/src/commands.rs`
- `plugins/budget/api/src/commands.rs`
- `plugins/cli/README.md`
- `plugins/cli/api/Cargo.toml`
- `plugins/cli/api/src/lib.rs`
- `plugins/cli/core/Cargo.toml`
- `plugins/cli/core/src/attach.rs`
- `plugins/cli/core/src/blocks/mod.rs`
- `plugins/cli/core/src/blocks/rich.rs`
- `plugins/cli/core/src/blocks/text.rs`
- `plugins/cli/core/src/completions.rs`
- `plugins/cli/core/src/decl.rs`
- `plugins/cli/core/src/human.rs`
- `plugins/cli/core/src/lib.rs`
- `plugins/cli/core/src/md.rs`
- `plugins/cli/core/src/term.rs`
- `plugins/cli/core/src/verbs.rs`
- `plugins/cli/core/tests/goldens.rs`
- `plugins/cli/core/tests/goldens/blocks/actions.txt`
- `plugins/cli/core/tests/goldens/blocks/app.txt`
- `plugins/cli/core/tests/goldens/blocks/blocked.txt`
- `plugins/cli/core/tests/goldens/blocks/callout.txt`
- `plugins/cli/core/tests/goldens/blocks/chart.txt`
- `plugins/cli/core/tests/goldens/blocks/checklist.txt`
- `plugins/cli/core/tests/goldens/blocks/code.txt`
- `plugins/cli/core/tests/goldens/blocks/commits.txt`
- `plugins/cli/core/tests/goldens/blocks/compare.txt`
- `plugins/cli/core/tests/goldens/blocks/diff.txt`
- `plugins/cli/core/tests/goldens/blocks/doc.txt`
- `plugins/cli/core/tests/goldens/blocks/files.txt`
- `plugins/cli/core/tests/goldens/blocks/flow.txt`
- `plugins/cli/core/tests/goldens/blocks/graph.txt`
- `plugins/cli/core/tests/goldens/blocks/hero.txt`
- `plugins/cli/core/tests/goldens/blocks/image.txt`
- `plugins/cli/core/tests/goldens/blocks/map.txt`
- `plugins/cli/core/tests/goldens/blocks/markdown.txt`
- `plugins/cli/core/tests/goldens/blocks/next.txt`
- `plugins/cli/core/tests/goldens/blocks/preview.txt`
- `plugins/cli/core/tests/goldens/blocks/question.txt`
- `plugins/cli/core/tests/goldens/blocks/sparkle.txt`
- `plugins/cli/core/tests/goldens/blocks/stats.txt`
- `plugins/cli/core/tests/goldens/blocks/steps.txt`
- `plugins/cli/core/tests/goldens/blocks/stuff.txt`
- `plugins/cli/core/tests/goldens/blocks/task.txt`
- `plugins/cli/core/tests/goldens/blocks/terminal.txt`
- `plugins/cli/core/tests/goldens/blocks/tests.txt`
- `plugins/cli/core/tests/goldens/blocks/tree.txt`
- `plugins/cli/core/tests/goldens/blocks/video.txt`
- `plugins/cli/core/tests/samples.json`
- `plugins/cli/host/Cargo.toml`
- `plugins/cli/host/src/lib.rs`
- `plugins/cli/host/tests/catalogue.rs`
- `plugins/cli/host/wisp-plugin.json`
- `plugins/cli/parity-gaps.txt`
- `plugins/crew/api/src/commands.rs`
- `plugins/issues/api/src/lib.rs`
- `plugins/later/api/src/commands.rs`
- `plugins/lsp/api/src/lib.rs`
- `plugins/machine/api/src/this_mac/commands.rs`
- `plugins/machines/api/src/commands.rs`
- `plugins/plugins/api/src/commands.rs`
- `plugins/review/api/src/lib.rs`
- `plugins/router/api/src/commands.rs`
- `plugins/runtime/api/src/commands/mod.rs`
- `plugins/settings/api/src/lib.rs`
- `plugins/terminal/api/src/commands.rs`
