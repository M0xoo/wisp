# wisp v2 architecture

This page is the map. The reasons are in `docs/adr/` (one decision per file). The plan they came from is
the *wisp v2 rewrite plan* (draft 9); `docs/v2-plan-coverage.md` maps every section of it to code. When code
and this page disagree, fix whichever one is wrong in the same PR.

## One sentence

**Rust for everything but the UI** (ADR-0013). One Rust binary, `wisp`, holds a small **kernel** that
hosts **plugins**: every feature's backend is a plugin crate. A **store** (SQLite) records every write in a
**change feed**. The **sync** layer turns that feed into topics, which every client and every peer
subscribes to by cursor. The UI is one Solid + TypeScript bundle built only from the **kit** (`@wisp/ui`).
It reads everything from one client store and runs the same in the browser, the desktop app and the
phone app.

```
 apps/web (Solid bundle) ── browser
 apps/desktop (Tauri)    ── same bundle, wisp core in-process
 mobile (Capacitor)      ── same bundle in the APK, its own frontend; sshj/grid as transports
        │  @wisp/client: entities · navigation · machines · drafts · settings · N peers
        ▼  SSE /api/events?topics&cursor  +  POST /api/cmd (Idempotency-Key)
 ┌──────────────────────────── wisp (Rust, one binary) ───────────────────────────────┐
 │ wisp-api (axum edge: auth → capability set, routes, SSE, static, previews)        │
 │ wisp-kernel: manifests · scopes · commands · events · interceptors · points ·     │
 │              services · capability sets · plugin groups · exec tier (JSON-RPC)    │
 │ wisp-store (rusqlite: WAL, STRICT, change feed, blobs, FTS5, v1 import)           │
 │ wisp-sync (sans-IO outbox, cursors, coalescing)   wisp-proc (PTY, process trees)   │
 │ plugins/*/host: runtime · harnesses (claude, codex, …) · git · worktrees · ship ·  │
 │   terminal · machines · grid-client · crew · goal · later · budget · router ·      │
 │   automations · channels (+telegram, slack, …) · mcp · connectors · stuff · …      │
 └───────────────────────────────────────────────────────────────────────────────────┘
 apps/grid (Rust): edge, hostd, boxd. One wisp per tenant box, the BoxPlugins group.
```

## Frontends are plugins (ADR-0024)

The GUI (`wisp.frontend.web`), the TUI (`wisp.frontend.tui`, `wisp tui`) and the CLI (`wisp.frontend.cli`)
are three plugins over the same command catalogue, topics and sync protocol. Each feature plugin contributes
to each through points (`web.extension`, `tui.view`, `tui.input`, `term.block`, `cli.verb`). None of them
reads the store; all of them can attach to any peer.

## Layout

```
Cargo.toml              the Rust workspace (flat: crates/* and plugins/*/{api,core,host})
crates/
  wisp-kernel/          plugin host: manifests, resolution, groups, scopes, commands, events,
                        interceptors, points, services, capability sets, exec tier
  wisp-store/           rusqlite: migrations per owner, entities → change feed, mutations, blobs (BLAKE3,
                        zstd), FTS5, retention, the v1 importer framework
  wisp-sync/            sans-IO sync server: hello/welcome, subs, outbox, coalescing, backpressure, window
  wisp-api/             axum edge: auth, Host/Origin rules, routes from the kernel.http point, SSE, /api/cmd,
                        static bundle, /_pack, previews, OpenAPI
  wisp-proc/            spawning, PTYs, process groups and Job Objects (the one reviewed unsafe module)
  wisp-testkit/         fake clock, fake harness, fake gh, plugin harness, goldens, simulation
  wisp/                 the binary: serve, mcp, plugin, import, grid …; plugin groups (the only place
                        features are named)
plugins/<name>/
  api/                  crate wisp-<name>-api: commands, events, hooks, points, services, row types
                        (other plugins depend on this only)
  core/                 crate wisp-<name>-core: pure logic, sans-IO parsers, deciders (no tokio, no fs)
  host/                 crate wisp-<name>: adapters and wiring; wisp-plugin.json lives here
  ui/                   package @wisp-plugin/<name>-ui: Solid extensions for the GUI, kit components only
  tui/                  crate wisp-<name>-tui: views, inputs and block renderers for the TUI and the CLI
                        (optional; the generated verbs and generic renderers cover a plugin without one)
packages/               TypeScript, UI only
  protocol/             wire types (generated from Rust by ts-rs, diffed in CI)
  sync/                 the client half: SyncClient, SSE parser, apply rules
  client/               the six kinds of client state, peers and transports
  tokens/ ui/ shell/    design tokens, the kit (the only CSS), the extension-tree shell
apps/
  web/                  the one bundle's entry
  desktop/              Tauri shell, embeds the wisp core
  grid/                 wisp Grid in Rust
mobile/                 Android (Capacitor + sshj): ships the bundle, its own frontend
npm/                    the wisp-agents launcher and @wisp/core-<os>-<arch> binary packages
tools/                  check (structure rules), test runner, budgets, codegen, setup-monoflow
docs/  design/  qa/  spikes/
```

## The rules that keep it this shape

Checked by `npm run check` (`tools/check`: the TypeScript rules and the Rust ones, `rust-*`, read from each
`Cargo.toml` and the `.rs` sources), clippy, and `cargo deny check` (`deny.toml`, ADR-0015):

1. **Layers.** Rust: `wisp-kernel` ← `wisp-store`, `wisp-sync`, `wisp-proc` ← `plugins/*/api` ←
   `plugins/*/core` ← `plugins/*/host` ← `wisp-api`, `wisp`. A plugin's host depends on other plugins'
   `api` crates only. `core` crates use no tokio, no `std::fs`, no `std::net`, no clock. TypeScript: tokens
   ← ui ← client ← shell ← plugins/*/ui ← apps.
2. **No cycles** between crates, packages or files.
3. **CSS only in `packages/ui`**; no `class`/`style` outside it (ADR-0007); nothing wraps that shouldn't
   (ADR-0012).
4. **State has one home** on the client (ADR-0006). **One write path** on the server (ADR-0004).
5. **Default deny:** every command, route and MCP tool is named by a capability set (ADR-0008).
6. **Contracts are versioned:** protocol shapes diffed against released snapshots; points and services carry
   majors; manifests validate.
7. **Performance budgets fail CI** (ADR-0011).
8. Files over 400 lines and functions over 60 lines warn.

## How a feature is built

1. Pick its owner plugin, or make one (the `add-plugin` skill).
2. Write the contract in `api/` first: commands, events, hooks, points, services, row types (`ts-rs`
   exports the ones the UI reads).
3. Pure logic in `core/` with property tests; wiring in `host/` against the kernel and other plugins' `api`.
4. UI in `ui/` from kit components, registered into the shell's inputs; writes through commands with an
   optimistic patch.
5. Tests next to the code; goldens for anything an agent, a peer or a released client reads.
6. `.agents/bin/monoflow verify --affected` before handing back.
