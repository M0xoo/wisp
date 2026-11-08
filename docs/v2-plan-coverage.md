# v2 plan coverage: every section, where it lives, who owns it

The plan: *wisp v2 rewrite plan*, draft 9 (`/Users/mokh/.wisp/stuff/63a85cccbd35-r9-wisp-rewrite-plan.md`).
The owner's decisions on top of it: **Rust for everything but the UI** (ADR-0013), **monoflow** for the
monorepo (ADR-0001), **performance first** (ADR-0011), **nothing wraps that shouldn't** (ADR-0012), and **the
phone ships its own frontend** (§7.3). The lead reviews this table before every hand-back; a row isn't
`done` until its test or measurement exists.

Status: ✅ done · 🟡 in progress · ⬜ not started

| Plan § | What it asks | Where | Owner | Status |
|---|---|---|---|---|
| §0 Data | SQLite WAL STRICT, append-only events, change feed | `crates/wisp-store` | store | ✅ store 78 tests pass (verifier 11-08); WA 14.1× not rerun |
| §0 Sync | topics + cursor on SSE, JSON Patch, POST commands, idempotency, retention, resync | `crates/wisp-sync`, `crates/wisp-api`, `packages/sync` (client) | sync, api | 🟡 sync 32 + api 61 tests pass (verifier); G3 not rerun |
| §0 Native | PTY + process trees in Rust | `crates/wisp-proc` | proc | ✅ proc 30 tests pass incl. g12 (verifier) |
| §0 Views | Solid (G10 tie → Solid) | `packages/ui`, `apps/web` | kit, ui-* | 🟡 home/task/composer parity 60/96 per mode, the rest from 4 diffs (verify-log R2-1…4); 32 views unreachable (R1 #21) |
| §0 Components | `@wisp/ui` on Zag, token-only CSS, `@layer`s, `data-part` | `packages/ui`, `packages/tokens` | kit | 🟡 kit css-rules test fails; gallery overflows at 390/320 (verify-log #8, #11) |
| §0 Extensibility | one concept: plugins; same power for users | kernel + every plugin | kernel | 🟡 kernel 64 tests pass (not 72); only 6/40 plugins in the binary (verify-log #25) |
| §0 Shells | Tauri desktop + Android Capacitor, both with their own frontend | `apps/desktop`, `mobile/` | shells | ⬜ |
| §1 Principles | few moving parts, one adapter per harness, crash-safe writes, narrow security, stable names, optimistic UI, slow links, docs checked | rules in AGENTS.md, tools/check | all | 🟡 |
| §2 Experiments | benches rerunnable in `spikes/` | `spikes/` | each owner | 🟡 |
| §3 Target | one Rust process; kernel/store/sync/plugins | `Cargo.toml`, `crates/` | lead | 🟡 workspace builds at HEAD `405ce172`; `wisp serve` runs tasks e2e (verifier R3) |
| §3.1 rule 1 | flat workspace, folder = crate name | `Cargo.toml` | lead | ✅ |
| §3.1 rule 2 | functional core, imperative shell; ports as traits | `core/` crates, kernel services | all | ⬜ |
| §3.1 rule 3 | sans-IO parsers/protocols; deterministic simulation | harness `core`, `wisp-sync`, `wisp-testkit` | harness, sync, testkit | ⬜ |
| §3.1 rule 4 | decider pattern for commands, one tx per command | `wisp-kernel` + `wisp-store` | kernel, store | ⬜ |
| §3.1 rule 5 | vertical slices `api/core/host/ui` | `plugins/*` | all | ⬜ |
| §3.1 rule 6 | kernel knows no feature | `wisp-kernel` | kernel | ✅ contract |
| §3.1 rule 7 | layered imports, public APIs only | tools/check (Rust + TS) | tooling | ✅ rust-layers + TS layers pass in `npm run check` (verifier) |
| §3.1 rule 8 | one command bus, one HTTP client, one write path, one error type, tracing, one config | kernel, client, store | all | 🟡 |
| §4.1 Model | session, turn, event, queue_item, project, crew_member, …, change, mutation, meta, FTS5, blobs CAS | store + plugin migrations | store, runtime | 🟡 runtime, crew (`crew_member`, `crew_layout`, `crew_job`), router (`router_*`) and My Stuff (`stuff_item`, `stuff_upload`, contents in the store's blobs) in wisp-store, each with a v1 importer; serve e2e `v1_files_are_imported_once_and_rows_live_in_the_store`. Debt: none of the rows above. Files kept on purpose: each app's own SQLite (ADR-0020), crew kit files (§4.8), copies of items agents read |
| §4.1 | write cadence 250 ms; only open/running sessions in memory; UUIDv7; plugin table prefixes | store, runtime | store, runtime | ⬜ |
| §4.1 Retention | change 7 d / 1M rows, mutation 24 h, oldest_seq, epoch | store, sync | store | ⬜ |
| §4.2 Versioning | migrations per plugin, VACUUM INTO, event `v` upcasters, presentation by parser version | store, runtime | store | ⬜ |
| §4.3–4.5 | protocol messages, fan-out outbox, mutations base+pending | sync, client | sync | 🟡 client ✅ |
| §4.6 | client state: six kinds, machines, nav, scoped async, plugin state, guardrails, devtools | `packages/client` | client | ✅ @wisp/client passes monoflow; `pending` in CommandDef (ADR-0018); devtools panel ⬜ |
| §4.7 Grid | one SQLite per tenant, control-plane SQLite, Litestream | `apps/grid` | grid | ⬜ |
| §4.8 Import | all of `~/.wisp`: sessions, config, spells→plugins, stuff/uploads→blobs, dual-write one release | store + each plugin's importer | each owner | 🟡 runtime (sessions, dual-write mirror), crew (config.json `crew`/`crewLayout`), router (router.json, `defaults.router`), stuff (stuff/uploads/shots → rows + blobs). Not dual-written: crew, router and stuff (v1's files stay as they were) |
| §5 UI | kit rules, lint, visual snapshots, perf rules, parts compat table (409 PARTS) | `packages/ui`, tools/check | kit, tooling | 🟡 |
| §5.1 | a11y (axe in QA), i18n `t()`, observability (logs, Diagnostics) | ui, client, kernel | kit, kernel | 🟡 |
| §6.0 | spells are plugins; same power; trust levels; rename "spell" everywhere | kernel, plugins plugin, UI, docs | plugins | ⬜ |
| §6.1/6.1b | kernel, plugin, module, service, points; interceptors with veto | `wisp-kernel` | kernel | 🟡 contract |
| §6.2 | manifest schema, validated in CI | `wisp-kernel::manifest`, tools/check | kernel | 🟡 |
| §6.3 | plugin groups Default/Box/Headless/Minimal; 3 ways to remove | `crates/wisp` | edge | 🟡 Default group in the binary: all 111 manifest commands answer on `wisp serve` (verifier R3); Box/Headless/Minimal not checked |
| §6.4 | lifecycle, lazy activation, scopes, hot switch | `wisp-kernel` | kernel | ⬜ |
| §6.5 | permissions, capability sets, default deny | `wisp-kernel::caps` | kernel | 🟡 every host has a manifest; rust-manifests passes; `Ctx::run_json` checks caller + plugin sets (verifier R3) |
| §6.6 | UI extension tree, inputs = old SLOTS, overrides | `packages/shell` | shell | 🟡 contract |
| §6.7 | tiers: built-in + exec (WASM cut) | `wisp-kernel` exec tier | kernel | ⬜ |
| §6.9 | agent protocol goldens: wisp blocks, 38 MCP tools, delegate/ask | runtime, mcp | runtime, channels | 🟡 MCP server lists and runs tools (serve e2e); delegate/ask diverge from v1 (verify-log R3-3, R3-4); no goldens |
| §6.10 | `wisp plugin new`, testkit free tests | `crates/wisp`, `wisp-testkit` | testkit | ⬜ |
| §6.11 | commands/events/interceptors/points/topics/services; no loops/deadlocks; Slack→budget example as a test | `wisp-kernel` | kernel | ⬜ |
| §7 | one web codebase; `platform` module | `apps/web`, `packages/shell` | shell | ⬜ |
| §7.1 | npm channel, per-platform binaries, signing | `npm/`, release.yml | release | ⬜ |
| §7.2 | peers not relays; transports as plugins; sleeping boxes; capability sets per peer; grid side | machines, grid-client, grid | machines | ⬜ |
| §7.3 | **phone and desktop ship their own frontend**; N peers; offline; compat contract; plugin UI served by peers; G13 | `mobile/`, `apps/desktop`, client | shells | ⬜ |
| §8 | budgets in CI | `tools/budgets.ts`, spikes | tooling | ⬜ |
| §9.1 | gates G1, G3, G6, G8, G9, G10, G11, G12, G13, G14 | spikes, qa | each owner | ⬜ |
| §9.2 | code-quality rules in CI from the first commit | workspace lints, tools/check | tooling | ✅ clippy -D warnings exit 0; cargo test 1,493 pass / 0 fail at HEAD `405ce172` (verifier R3) |
| §9.3 | parity oracle: recorded HTTP/SSE/MCP goldens from v1 | `qa/goldens`, testkit | testkit | ⬜ |
| §9.4 | monorepo by monoflow; G14 | `.agents/`, CI | tooling | 🟡 monoflow verify --all 151/151 at HEAD (verifier R3); G14 not run |
| §10 | risks: ADR per dependency, cargo-deny | `deny.toml` | tooling | 🟡 cargo deny check passes (11 duplicate warnings); ADR per dependency not checked |
| Owner | nothing wraps (ADR-0012), `qa/layout.mjs` | kit, ui-* | kit | 🟡 layout --area=shell 0 problems (60 page-shots); gallery 4 overflow (R1 #11); 320 folds allowed (allowed.md §4) |
| v1 parity | **PostHog telemetry: all 52 v1 events** (same names, properties, opt-out, scrubbing, sampling) from server and UI: account, agent_launch, agent_login, agent_task, app_started, approval, ask_user, auto_override, auto_settled, btw, channel_event, compact, connector_tool, crew_imported, crew_shared, crew_tool, delegate, exec_action, fork_task, getapp_clicked, getapp_hidden, getapp_opened, harness_install, merge, move_task, resume_later, retro, run_app, shell, ship, side_task, spell_hook, spell_installed, stuff_add, stuff_launch, stuff_publish, stuff_save, takeover, task_import, task_share, try_two_ways, turn_ended, turn_started, update, wisp_available, wisp_pr, wisp_session, wisp_sessions, wisp_stats, wisp_tag, wisp_watch, worktrees_brought_in | `plugins/telemetry` + every emitting plugin; golden of the event inventory | coder | ⬜ v2 sends none yet |
| v1 parity | **Prompt features:** task mentions `@[Title](wisp:<id>)` (agent gets `@Title (wisp task <id>)` + how to read it, or the report inline for runs without MCP: v1 server/mentions.js), My Stuff mentions, crew `@Name` mentions, pasting a copied task id makes a mention, the `@` picker in every prompt box | `plugins/runtime` (prompt assembly), `plugins/stuff`, `plugins/crew`, `plugins/shell-composer/ui` | coder | 🟡 crew mentions ported; task + stuff mentions ⬜ |
| v1 parity | **Slash commands in prompts** (`/goal`, `/btw`, `/compact`, `/after`, `/later`, recipes, harness slash commands passed through: v1 web/js/features/slash.js, slash-text.js, adapters/commands.js) | `plugins/shell-composer/ui` → commands of their owning plugins | coder | 🟡 commands exist (btw, compact, later); the composer's `/` menu and routing ⬜ |
| v1 parity | **Sharing tasks** (share a task on wisp Grid, open/import someone's shared task, share view: v1 services/share.js, share-view.js, share-in.js) | `plugins/grid-client` + its ui | coder | ⬜ |
| v1+ | **CLI covers the GUI** (ADR-0022): every catalogue command as `wisp <plugin> <verb>`, `--watch` on topics, `wisp attach <id>` live view with asks/approvals, `--json`, completions, generated help + site page, parity test | `crates/wisp` | coder | ⬜ **next after the current backend job** (owner: focus on the CLI); blocks render natively in the terminal |
| v2 new | **Terminal context** (ADR-0023): `wisp "check the error above"` attaches cwd, git status, last commands + exit codes and the failing output, from tmux/WezTerm/kitty/iTerm2/Terminal/VS Code or the opt-in `wisp shell-init` hook; secret-scanned; never re-runs anything | `plugins/termctx`, `crates/wisp` | coder | ⬜ after ADR-0022 CLI |
| v2 new | **TUI** (ADR-0024): `wisp tui` mirrors the GUI (list, task + live transcript + blocks, composer with @ and /, asks/approvals, crew, My Stuff, Settings forms, palette); a sync client like the phone; parity test vs the GUI's catalogue reach | `wisp.tui`, `plugins/*/tui` | coder | ⬜ after the CLI |
| v2 new | **Frontends are plugins** (ADR-0024): web, TUI, CLI as `wisp.web`, `wisp.tui`, `wisp.cli`; points web.extension, tui.view, tui.input, term.block, cli.verb; Rust SyncClient in wisp-sync | kernel groups, `crates/wisp-sync` | coder | ⬜ with the CLI job |
| v2 new | **wisp as code** (ADR-0026): resource kinds per plugin (`resource.kind@1`), `wisp.yml` formulas, `wisp apply/export/diff/validate/schema`, `wisp run --formula`, `wisp grid deploy`, export round-trips, drift shown in Settings | `plugins/resources` + every owning plugin | coder | ⬜ after the CLI |
| v2 new | **Task specs** (ADR-0027): spec vs history; `wisp rerun <id>` (same base sha, overrides), fork, share at 3 levels (spec/report/full, scrubbed), `wisp task export`, declared `tasks:` in formulas; recipes/triggers/crew jobs/compare built on specs | `plugins/runtime`, `plugins/resources`, grid-client (share) | coder | ⬜ with ADR-0026 |
| v2 new | **Code first** (ADR-0028): every configurable thing is a resource kind (project, harness, account, agent profile, team, skill, crew, machine + limits, connector, tools, capability, channel, notification, recipe, trigger, workflow, goal, budget, router, pipeline, plugin, app/pane, ui, setting, grid/box); workflows = DAGs of task specs (needs/if/matrix/on/output/budget); TS + Python SDKs from the catalogue; trust for foreign formulas; check: no configurable feature without a kind | `plugins/resources`, `plugins/workflows`, every owner, `npm/`, `sdk/python` | coder | ⬜ after the CLI |
| launch | **Docs and positioning rework: "Agents as code"** (marketing/positioning-v2.md): README, site (home, guides, integrations, agents), generated CLI + formula + schema reference, plugin guide, TS/Python SDK guides, formula cookbook, v1→v2 migration guide, launch post; researcher verifies the "no other open source does this" claim first | `README.md`, `docs/`, `scripts/site.mjs`, `scripts/guides.mjs`, `marketing/` | marketing + researcher + lead | ⬜ at the end |
| v2 new | **History + formula reruns** (ADR-0029): formula snapshot per task (by hash), "ran with … / changed since", history queries and export, retention setting, lineage; `wisp rerun --formula x.yml` (names resolve in the new formula, plan shows missing ones), compare N formulas, evaluate a formula on the last N real tasks, `wisp task formula <id>` | `plugins/runtime`, `plugins/resources`, compare UI | coder | ⬜ with ADR-0027 |
| v2 new | **Repo agent history** (ADR-0033): `.wisp/` committed with the code (wisp.yml, tasks/*.task.yml + reports, formula snapshots, opt-in full history), commit trailers `Wisp-Task:`, `wisp blame/log/resume/tasks --touching`, agents read it via MCP, `wisp init` | `plugins/runtime`, `plugins/git`, `plugins/ship`, `plugins/mcp`, CLI | coder | ⬜ after task specs/sharing |
