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
| [0016](0016-foundation-metrics.md) | One set of exact metrics (design/foundation.md), checked in Chrome |
