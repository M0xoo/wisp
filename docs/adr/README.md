# Architecture decision records

One decision per file, numbered, never edited after it merges: a later ADR supersedes an earlier one
and says so in its Status line (`superseded by ADR-00NN`). Write one with the `record-decision` skill
(`.claude/skills/record-decision/SKILL.md`) whenever a change adds a package kind, a dependency, a kind of
state, a wire message, or turns off a rule in `tools/check`.

| ADR | Decision |
|---|---|
| [0001](0001-monorepo-monoflow.md) | npm workspaces monorepo, handled by monoflow |
| [0002](0002-typescript-node-zero-deps.md) | ~~TypeScript on Node for the server~~ superseded by 0013 |
| [0003](0003-everything-is-a-plugin.md) | Everything is a plugin: kernel, manifests, scopes, interceptors, services; spells are plugins |
| [0004](0004-store-sqlite-change-feed.md) | node:sqlite store with a change feed and one write path |
| [0005](0005-sync-topics-cursors.md) | Sync: topics and cursors over SSE, commands by POST |
| [0006](0006-client-state.md) | Client state: six kinds, one home each |
| [0007](0007-ui-solid-kit.md) | Solid + a strict kit; feature CSS banned |
| [0008](0008-capability-sets.md) | Capability sets replace capped.js |
| [0009](0009-rust-wisp-native.md) | ~~Rust only in wisp-native~~ superseded by 0013 |
| [0010](0010-peers-transports.md) | Peers and transports; one bundle on every device |
| [0011](0011-performance-budgets.md) | Performance budgets fail CI like tests |
| [0012](0012-no-wrapping-bars.md) | Control text never wraps; bars collapse to icons, then More |
| [0013](0013-rust-for-everything-but-the-ui.md) | **Rust for everything but the UI**; Solid + TypeScript only for UI |
| [0014](0014-grid-control-plane.md) | The grid keeps its own SQLite control plane; its trust rules are data (now in Rust, ADR-0013) |
| [0015](0015-rust-dependencies.md) | The Rust workspace's third-party crates, each with its reason; `cargo deny` guards them |
| [0016](0016-foundation-metrics.md) | v2 looks exactly like v1: pixel + metrics parity gate |
| [0017](0017-immediate-feedback.md) | Every action answers within one frame (design/feedback.md, qa/feedback.mjs) |
| [0019](0019-openapi-from-the-route-table.md) | OpenAPI is checked on the Rust route table (crates/wisp/tests/serve_task.rs); the static `openapi` rule is retired |
| [0020](0020-per-app-sqlite.md) | A launched app keeps its own SQLite file outside wisp's store (a recorded kind of state) |
| [0021](0021-analytics-sinks.md) | Analytics: one pipeline, pluggable sinks (PostHog is a module) |
| [0022](0022-cli-covers-the-gui.md) | Everything the GUI can do, the CLI can do (generated from the command catalogue) |
| [0023](0023-jiff-for-time-zones.md) | `jiff` resolves IANA time zones, in host crates only |
| [0023](0023-terminal-context.md) | `wisp` reads the terminal it ran in (tmux, WezTerm, kitty, iTerm2, Terminal, VS Code, shell hook), scrubbed |
| [0024](0024-frontends-are-plugins.md) | GUI, TUI and CLI are frontend plugins over the same catalogue, topics and sync protocol |
