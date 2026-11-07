# v2 plan coverage: every section, where it lives, who owns it

The plan: *wisp v2 rewrite plan*, draft 9 (`/Users/mokh/.wisp/stuff/63a85cccbd35-r9-wisp-rewrite-plan.md`).
The owner's decisions on top of it: **Rust for everything but the UI** (ADR-0013), **monoflow** for the
monorepo (ADR-0001), **performance first** (ADR-0011), **nothing wraps that shouldn't** (ADR-0012), and **the
phone ships its own frontend** (§7.3). The lead reviews this table before every hand-back; a row isn't
`done` until its test or measurement exists.

Status: ✅ done · 🟡 in progress · ⬜ not started

| Plan § | What it asks | Where | Owner | Status |
|---|---|---|---|---|
| §0 Data | SQLite WAL STRICT, append-only events, change feed | `crates/wisp-store` | store | ⬜ |
| §0 Sync | topics + cursor on SSE, JSON Patch, POST commands, idempotency, retention, resync | `crates/wisp-sync`, `crates/wisp-api`, `packages/sync` (client) | sync, api | 🟡 client ✅ |
| §0 Native | PTY + process trees in Rust | `crates/wisp-proc` (from native/) | proc | 🟡 |
| §0 Views | Solid (G10 tie → Solid) | `packages/ui`, `apps/web` | kit, ui-* | 🟡 |
| §0 Components | `@wisp/ui` on Zag, token-only CSS, `@layer`s, `data-part` | `packages/ui`, `packages/tokens` | kit | 🟡 |
| §0 Extensibility | one concept: plugins; same power for users | kernel + every plugin | kernel | 🟡 contract |
| §0 Shells | Tauri desktop + Android Capacitor, both with their own frontend | `apps/desktop`, `mobile/` | shells | ⬜ |
| §1 Principles | few moving parts, one adapter per harness, crash-safe writes, narrow security, stable names, optimistic UI, slow links, docs checked | rules in AGENTS.md, tools/check | all | 🟡 |
| §2 Experiments | benches rerunnable in `spikes/` | `spikes/` | each owner | 🟡 |
| §3 Target | one Rust process; kernel/store/sync/plugins | `Cargo.toml`, `crates/` | lead | 🟡 |
| §3.1 rule 1 | flat workspace, folder = crate name | `Cargo.toml` | lead | ✅ |
| §3.1 rule 2 | functional core, imperative shell; ports as traits | `core/` crates, kernel services | all | ⬜ |
| §3.1 rule 3 | sans-IO parsers/protocols; deterministic simulation | harness `core`, `wisp-sync`, `wisp-testkit` | harness, sync, testkit | ⬜ |
| §3.1 rule 4 | decider pattern for commands, one tx per command | `wisp-kernel` + `wisp-store` | kernel, store | ⬜ |
| §3.1 rule 5 | vertical slices `api/core/host/ui` | `plugins/*` | all | ⬜ |
| §3.1 rule 6 | kernel knows no feature | `wisp-kernel` | kernel | ✅ contract |
| §3.1 rule 7 | layered imports, public APIs only | tools/check (Rust + TS) | tooling | 🟡 TS ✅ |
| §3.1 rule 8 | one command bus, one HTTP client, one write path, one error type, tracing, one config | kernel, client, store | all | 🟡 |
| §4.1 Model | session, turn, event, queue_item, project, crew_member, …, change, mutation, meta, FTS5, blobs CAS | store + plugin migrations | store, runtime | ⬜ |
| §4.1 | write cadence 250 ms; only open/running sessions in memory; UUIDv7; plugin table prefixes | store, runtime | store, runtime | ⬜ |
| §4.1 Retention | change 7 d / 1M rows, mutation 24 h, oldest_seq, epoch | store, sync | store | ⬜ |
| §4.2 Versioning | migrations per plugin, VACUUM INTO, event `v` upcasters, presentation by parser version | store, runtime | store | ⬜ |
| §4.3–4.5 | protocol messages, fan-out outbox, mutations base+pending | sync, client | sync | 🟡 client ✅ |
| §4.6 | client state: six kinds, machines, nav, scoped async, plugin state, guardrails, devtools | `packages/client` | client | ✅ (devtools panel ⬜) |
| §4.7 Grid | one SQLite per tenant, control-plane SQLite, Litestream | `apps/grid` | grid | ⬜ |
| §4.8 Import | all of `~/.wisp`: sessions, config, spells→plugins, stuff/uploads→blobs, dual-write one release | store + each plugin's importer | each owner | ⬜ |
| §5 UI | kit rules, lint, visual snapshots, perf rules, parts compat table (409 PARTS) | `packages/ui`, tools/check | kit, tooling | 🟡 |
| §5.1 | a11y (axe in QA), i18n `t()`, observability (logs, Diagnostics) | ui, client, kernel | kit, kernel | 🟡 |
| §6.0 | spells are plugins; same power; trust levels; rename "spell" everywhere | kernel, plugins plugin, UI, docs | plugins | ⬜ |
| §6.1/6.1b | kernel, plugin, module, service, points; interceptors with veto | `wisp-kernel` | kernel | 🟡 contract |
| §6.2 | manifest schema, validated in CI | `wisp-kernel::manifest`, tools/check | kernel | 🟡 |
| §6.3 | plugin groups Default/Box/Headless/Minimal; 3 ways to remove | `crates/wisp` | edge | ⬜ |
| §6.4 | lifecycle, lazy activation, scopes, hot switch | `wisp-kernel` | kernel | ⬜ |
| §6.5 | permissions, capability sets, default deny | `wisp-kernel::caps` | kernel | 🟡 |
| §6.6 | UI extension tree, inputs = old SLOTS, overrides | `packages/shell` | shell | 🟡 contract |
| §6.7 | tiers: built-in + exec (WASM cut) | `wisp-kernel` exec tier | kernel | ⬜ |
| §6.9 | agent protocol goldens: wisp blocks, 38 MCP tools, delegate/ask | runtime, mcp | runtime, channels | ⬜ |
| §6.10 | `wisp plugin new`, testkit free tests | `crates/wisp`, `wisp-testkit` | testkit | ⬜ |
| §6.11 | commands/events/interceptors/points/topics/services; no loops/deadlocks; Slack→budget example as a test | `wisp-kernel` | kernel | ⬜ |
| §7 | one web codebase; `platform` module | `apps/web`, `packages/shell` | shell | ⬜ |
| §7.1 | npm channel, per-platform binaries, signing | `npm/`, release.yml | release | ⬜ |
| §7.2 | peers not relays; transports as plugins; sleeping boxes; capability sets per peer; grid side | machines, grid-client, grid | machines | ⬜ |
| §7.3 | **phone and desktop ship their own frontend**; N peers; offline; compat contract; plugin UI served by peers; G13 | `mobile/`, `apps/desktop`, client | shells | ⬜ |
| §8 | budgets in CI | `tools/budgets.ts`, spikes | tooling | ⬜ |
| §9.1 | gates G1, G3, G6, G8, G9, G10, G11, G12, G13, G14 | spikes, qa | each owner | ⬜ |
| §9.2 | code-quality rules in CI from the first commit | workspace lints, tools/check | tooling | 🟡 |
| §9.3 | parity oracle: recorded HTTP/SSE/MCP goldens from v1 | `qa/goldens`, testkit | testkit | ⬜ |
| §9.4 | monorepo by monoflow; G14 | `.agents/`, CI | tooling | 🟡 |
| §10 | risks: ADR per dependency, cargo-deny | `deny.toml` | tooling | ⬜ |
| Owner | nothing wraps (ADR-0012), `qa/layout.mjs` | kit, ui-* | kit | 🟡 |
