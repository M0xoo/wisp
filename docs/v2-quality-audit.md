# v2 quality audit, 2026-11-08

The owner's instruction: *code quality and the architecture are respected, strictly.* This is what the
lead's checks found. Each finding is fixed in the next pass, and each rule becomes a check that fails CI, so
it can't come back.

## Findings

| # | Rule (where it is written) | Finding | Fix | Status (2026-11-08) |
|---|---|---|---|---|
| 1 | A plugin depends on other plugins' `api` only (ARCHITECTURE.md rule 1, ADR-0003) | `wisp-{discord,email,github,ntfy,slack,telegram}` depend on `wisp-channels-core` | Move what the transports share into `wisp-channels-api` (types, the transport trait) or a `channels.kit` service. Transports depend on `wisp-channels-api` only. | **Fixed.** The six hosts declared `wisp-channels-core` and used none of it: the dependency is gone, they use `wisp-channels-api` only. `rust-layers` fails on it now. |
| 2 | Only `Wrap` wraps (ADR-0012) | `packages/ui/src/css/transcript.css:16`, `:51` use `flex-wrap: wrap` | Use the kit's `Wrap` for those groups, or justify each line with a `/* wrap: reason */` the check accepts. | **Fixed.** Bubble attachments render in `Wrap`; a timeline step is a grid (row and end slot, detail on its own line). Its `:has()` became a `data-corner` attribute. |
| 3 | No CSS outside the kit (ADR-0007) | `plugins/{issues,ship,stuff}/ui/dev/harness.tsx` import `@wisp/ui/kit.css` | Dev harnesses mount through `@wisp/shell`'s dev entry, which loads the kit CSS itself. | **Fixed.** The harnesses (and the crew, goal, later and router dev pages) import `@wisp/ui/styles`, the kit's own module that loads its CSS, as `apps/web` does. |
| 4 | Imports are declared (monoflow sees every edge) | `plugins/goal/ui/src/Faces.tsx` imports `@wisp/tokens` without declaring it | Declare it, or use the kit's exported token types. | **Fixed.** Declared in `plugins/goal/ui/package.json` (and the lockfile). |
| 5 | Files ≤ 400 lines (§9.2) | 34 Rust files over 400 lines (`wisp-kernel/src/caps.rs` 513, …) | Split by concern. Keep a file over 400 only with a reason in its header, and the check lists those. | **Fixed.** Split: `wisp-api/src/v2.rs` (529 → 271 + `v2_actor.rs` 284), `claude/core/src/describe.rs` (445 → 331 + `describe_tests.rs`). The other 32 src files carry a `//! size-ok:` reason in their header; `rust-sizes` warns on any that doesn't (test files are exempt). 75 fns over 60 lines remain as warnings. |
| 6 | `wisp-git` builds | broken by an error in `wisp-proc` | Fix in `wisp-proc`, and make `exec` run off the runtime thread (rs-git's ask). | **Fixed.** `LocalProc::exec` resolves and forks on the blocking pool; `wisp-git` dropped its own `spawn_blocking` wrap. Clippy's `manual_is_multiple_of` in `wisp-proc/tests/g12.rs` fixed. |
| 7 | One write path; events after commit (ADR-0004) | The edge's v2 driver doesn't read from the store yet: v2 topics are empty | Wire `Store::on_commit` → kernel `CommitHook` → `wisp-sync` `committed`, plus snapshots through `changed_since`/`query_json`. | **Fixed.** `wisp serve` opens `<home>/wisp.db`, provides it as a kernel service, and mounts the driver on `wisp_api::v2_store::StoreSnapshots` (deltas via `changed_since`, full topics via `query_json`) with `feed()` streaming every commit to `Driver::committed`. `Store::write_for(hook, call, f)` ties a command's write to the kernel's `CommitHook` (mark → committed(head) / rolled_back). Tested end to end in `crates/wisp-api/tests/v2_store.rs`. |

Clean: no `unsafe` outside `wisp-proc/src/sys`; no `unwrap`/`expect` outside tests; no `core` crate depends on
tokio, fs, net or a database; no base crate depends on a plugin.

## Checks to add (so these can't come back)

All added (2026-11-08): `tools/check/rules/rust.ts` (fixture tests in `tools/check/test/rust.test.ts`), run by
`npm run check`; CI (`.github/workflows/suite.yml`) runs clippy, `cargo test --workspace` and `cargo deny`
(`deny.toml`). The manifests rule found `plugins/runtime/host/wisp-plugin.json` listing its 26 commands as
bare strings, which `Manifest::parse` refuses: they are `{id, title}` now.


`tools/check` gets Rust rules, read from `cargo metadata` and the sources:
- `rust-layers`: a plugin's crates depend on other plugins' `-api` crates only; `api`/`core` never depend on
  their own `host`; base crates (`crates/*` except `wisp`) depend on no plugin.
- `rust-sans-io`: `plugins/*/core` and `wisp-sync`/`wisp-protocol` have no tokio, reqwest, axum, rusqlite or
  wisp-proc dependency, and their sources don't use `std::fs`, `std::net`, `std::process` or
  `SystemTime::now`/`Instant::now`.
- `rust-unsafe`: `unsafe` only in `crates/wisp-proc/src/sys/`.
- `rust-sizes`: files > 400 lines and functions > 60 lines warn, unless the file names a reason.
- `rust-manifests`: every `plugins/*/host` has a `wisp-plugin.json` that `Manifest::parse` accepts, and every
  command it registers is named in a capability set.
- CI runs `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` through
  monoflow, plus `cargo deny` for licences and advisories (plan §10).
