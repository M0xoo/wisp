# wisp v2: brief for every agent building it

You are building part of **wisp v2** in this folder (a git worktree, branch
`wisp/we-are-going-to-work-on-wisp-v2-8fb64e`). The owner's words: *wisp v2 = wisp v1 with the new
architecture*, in one PR, so that after it merges only what v2 needs is left. They expect the best codebase
ever made. Nothing below is optional.

## The owner's decisions (final, don't reopen)

1. **Rust for everything but the UI** (ADR-0013): kernel, store, sync, HTTP edge, process supervision,
   MCP, CLI, grid and **every plugin's backend, harness runners included**. Solid + TypeScript only for UI.
2. **monoflow** handles the monorepo (ADR-0001).
3. **Performance first** (ADR-0011): we are building the fastest dev tool there is.
4. **Nothing wraps that shouldn't** (ADR-0012, `design/layout.md`).
5. **The phone and desktop apps ship their own frontend** (plan §7.3), talking to computers over the sync
   protocol. The phone no longer renders a remote WebView.
6. Everything else is in the plan: `/Users/mokh/.wisp/stuff/63a85cccbd35-r9-wisp-rewrite-plan.md`. Read the
   sections your brief names, and check `docs/v2-plan-coverage.md` for the row you own.

## Read first

`AGENTS.md` (rules), `ARCHITECTURE.md` (map), the ADRs for your area, `crates/wisp-kernel/src/lib.rs` and
`host.rs` (the plugin contract: frozen signatures, extend additively and say so), and for behaviour:
v1 itself (`server/`, `web/`, `grid/`, `test/`), `docs/v1-edge-cases.md` and `docs/v1-edge-cases-crew.md`
(every bullet becomes a test), and the TypeScript reference port at git tag `v2-ts-server-reference`
(`git show v2-ts-server-reference:plugins/<x>/...`), which already solved many edge cases. Port behaviour,
not code.

## monoflow (mandatory) and the shared worktree

- `.agents/bin/monoflow graph impact <file>` before you change a contract (an `api` crate, the kernel,
  `@wisp/protocol`).
- `.agents/bin/monoflow verify --package=<your crate or package>` after each change: **the gate**. Rust
  crates are packages to monoflow too.
- **Never** run `monoflow checkpoint revert`, `commit`, `outer` or `ship`, and never `git clean`, `git
  stash`, `git checkout -- .`, `git reset` or `rm -rf` outside your own directories. This worktree is shared
  by many agents; reverts deleted other agents' files several times on 2026-11-07. `checkpoint save` is fine.
- Never commit or push: the lead commits.

## Rust specifics

- Each new crate folder gets its `Cargo.toml` **first** (the workspace globs `crates/*`,
  `plugins/*/{api,core,host}`; a folder without one breaks everyone's build). Use `[lints] workspace = true`
  and workspace dependencies. A dependency not in the root `Cargo.toml` needs a line there plus a sentence in
  your report (the lead records it in an ADR).
- **Build with your own target dir:** `export CARGO_TARGET_DIR=/tmp/wisp-target-<your-name>`, and build or
  test only your crates (`cargo test -p <crate>`). Never `cargo build --workspace` (the machine is shared).
- Plan §9.2: no `unsafe` (except `wisp-proc`'s reviewed sys module), clippy pedantic clean
  (`cargo clippy -p <crate> --all-targets -- -D warnings`), no `unwrap`/`expect`/`panic` outside tests,
  one `thiserror` enum per crate mapped to `WireError`, `tracing` spans on commands.
- **Shape of a plugin:** `plugins/<name>/api` (crate `wisp-<name>-api`: `Command`/`Event`/`Hook` types,
  `Point`s, `Service` traits, row types with `#[derive(ts_rs::TS)]` for what the UI reads),
  `plugins/<name>/core` (crate `wisp-<name>-core`: pure, sans-IO, no tokio/fs/net/clock: parsers, deciders,
  state machines; property tests here), `plugins/<name>/host` (crate `wisp-<name>`, with `wisp-plugin.json`
  beside its Cargo.toml: `impl Plugin`, wiring to the kernel, store, proc and HTTP routes). A host depends
  on other plugins' `api` crates only.
- **v1's HTTP API stays** as thin route adapters over commands (`Setup::route`), same paths and JSON
  shapes, so v1 clients keep working and v1's route tests port almost 1:1.
- **Work in two phases.** Phase A (start now): `api` + `core`, with every v1 behaviour and edge case for
  your area as tests. Phase B: `host` wiring, once `crates/wisp-kernel` and `crates/wisp-store` are
  implemented (look for `crates/wisp-kernel/READY` and `crates/wisp-store/READY`; until then, write host
  code against their public signatures and keep going).

## UI (TypeScript + Solid only)

UI agents read `docs/v2-ui-brief.md` as well.

## Quality bar

- Files ≤ 400 lines, functions ≤ 60, unless there's a written reason. Comments say *why*, briefly.
- Tests need no network and no real harness. Goldens for anything an agent, a peer or a released client
  reads. Hot paths come with a bench in `spikes/<area>/` (criterion is not in the workspace: use a plain
  `[[bench]]`-free binary or a `#[test] #[ignore]` bench), and numbers in your report.
- Your report: what you built (files), its public API, tests and the monoflow verify output, bench
  numbers, plan-coverage rows you moved, and what you need from another crate.
