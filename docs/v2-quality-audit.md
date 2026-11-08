# v2 quality audit, 2026-11-08

The owner's instruction: *code quality and the architecture are respected, strictly.* This is what the
lead's checks found. Each finding is fixed in the next pass, and each rule becomes a check that fails CI, so
it can't come back.

## Findings

| # | Rule (where it is written) | Finding | Fix |
|---|---|---|---|
| 1 | A plugin depends on other plugins' `api` only (ARCHITECTURE.md rule 1, ADR-0003) | `wisp-{discord,email,github,ntfy,slack,telegram}` depend on `wisp-channels-core` | Move what the transports share into `wisp-channels-api` (types, the transport trait) or a `channels.kit` service. Transports depend on `wisp-channels-api` only. |
| 2 | Only `Wrap` wraps (ADR-0012) | `packages/ui/src/css/transcript.css:16`, `:51` use `flex-wrap: wrap` | Use the kit's `Wrap` for those groups, or justify each line with a `/* wrap: reason */` the check accepts. |
| 3 | No CSS outside the kit (ADR-0007) | `plugins/{issues,ship,stuff}/ui/dev/harness.tsx` import `@wisp/ui/kit.css` | Dev harnesses mount through `@wisp/shell`'s dev entry, which loads the kit CSS itself. |
| 4 | Imports are declared (monoflow sees every edge) | `plugins/goal/ui/src/Faces.tsx` imports `@wisp/tokens` without declaring it | Declare it, or use the kit's exported token types. |
| 5 | Files ≤ 400 lines (§9.2) | 34 Rust files over 400 lines (`wisp-kernel/src/caps.rs` 513, …) | Split by concern. Keep a file over 400 only with a reason in its header, and the check lists those. |
| 6 | `wisp-git` builds | broken by an error in `wisp-proc` | Fix in `wisp-proc`, and make `exec` run off the runtime thread (rs-git's ask). |
| 7 | One write path; events after commit (ADR-0004) | The edge's v2 driver doesn't read from the store yet: v2 topics are empty | Wire `Store::on_commit` → kernel `CommitHook` → `wisp-sync` `committed`, plus snapshots through `changed_since`/`query_json`. |

Clean: no `unsafe` outside `wisp-proc/src/sys`; no `unwrap`/`expect` outside tests; no `core` crate depends on
tokio, fs, net or a database; no base crate depends on a plugin.

## Checks to add (so these can't come back)

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
