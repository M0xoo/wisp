# ADR-0013: Rust for everything but the UI

- Status: accepted. Supersedes ADR-0002 (TypeScript on Node for the server) and ADR-0009 (Rust only in
  wisp-native), and the server halves of ADR-0003, ADR-0004 and ADR-0005.
- Date: 2026-11-08
- Source: the owner: "the plan is clear: Rust for everything, Solid and TypeScript only for UI. Even
  plugins use Rust for anything backend or local runner." The plan's target architecture (§3, §3.1,
  §6.2, §6.3, §6.7) describes exactly this; plan §0.2 had left it to the owner, who has decided.

## Context

The first v2 attempt kept the server in TypeScript on Node, following §0.2's recommendation. The owner
reads the plan's target (one Rust `wisp-core` binary, plugins as crates) as the decision.

## Decision

- **Rust (Cargo workspace at the repo root):** the kernel (`wisp-kernel`), the store (`wisp-store`,
  rusqlite, WAL, STRICT), the sync server (`wisp-sync`, sans-IO), the HTTP/SSE edge (`wisp-api`, axum),
  process supervision and PTYs (`wisp-proc`, portable-pty, process groups and Job Objects), the MCP server,
  the CLI (`wisp` binary), the grid (edge, hostd, boxd), and **every plugin's backend**: harness runners,
  runtime, git, worktrees, ship, terminal, machines, crew, goal, later, budget, Auto, automations,
  channels, connectors, stuff, plugins, telemetry, update. A plugin is `plugins/<name>/{api,core,host}`
  crates plus a `ui/` package.
- **TypeScript + Solid only for UI:** `@wisp/protocol` (wire types, generated from Rust with ts-rs and
  diffed in CI), `@wisp/client` and the client half of `@wisp/sync`, `@wisp/tokens`, `@wisp/ui`,
  `@wisp/shell`, `plugins/*/ui`, `apps/web`. The same bundle runs in the browser, in the Tauri desktop
  app (which embeds the Rust core in-process), and in the Android app (its own frontend, plan §7.3).
- **User plugins** keep two tiers: declarative manifests, and the exec tier (a subprocess speaking
  JSON-RPC over stdio, any language). Built-ins are Rust crates against the same contracts.
- **Distribution:** npm stays the channel. `wisp-agents` is a tiny JS launcher (no dependencies) plus
  per-platform `optionalDependencies` holding the `wisp` binary (`@wisp/core-<os>-<arch>`, the esbuild
  model). Homebrew and the desktop app ship the same binary. Binary budget ≤ 15 MB stripped.
- Code rules: plan §9.2 (forbid unsafe except the reviewed sys module, clippy pedantic, no
  unwrap/expect/panic outside tests, thiserror per crate, `WireError` at the edge, tracing spans per
  command); functional core and imperative shell; sans-IO protocols and parsers; deciders for commands.

## Consequences

- Start time, memory and parse cost drop by the plan's measured factors (§2.2: 25× faster cold start,
  13× less idle RSS, 3.7× faster parsing).
- Contributors need Rust. Builds use one shared target directory per machine, and `sccache` in CI.
- monoflow must see Cargo crates (its origin/main does) and verifies Rust crates like npm packages.
- The TypeScript server port (tag `v2-ts-server-reference`) and `docs/v1-edge-cases*.md` are the
  behaviour reference for the Rust port, alongside v1 itself.
