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
| [0025](0025-jiff-for-time-zones.md) | jiff for time zones (later, host crates only) |
| [0026](0026-wisp-as-code.md) | wisp as code: resources owned by plugins; `wisp apply/export/diff`, `--formula`, `grid deploy` |
| [0027](0027-task-specs.md) | A task = spec + history: rerun, fork, share (spec/report/full), declared tasks and recipes as specs |
| [0028](0028-code-first.md) | Code first: every resource kind listed; workflows (DAGs of task specs); TS/Python SDKs; trust for foreign formulas |
| [0029](0029-history-and-formula-reruns.md) | History is data with a snapshot of the formula it ran with; rerun/compare under other formulas |
| [0031](0031-no-v1-compatibility.md) | No compatibility with v1 interfaces (routes, events, spells, dual-write, v1 peers); keep v1 look as spec + one-time importer |
| [0033](0033-repo-carries-its-agent-history.md) | A repo carries its agent history in `.wisp/` (specs, reports, formulas; blame, log, resume) |
| [0034](0034-formulas-as-modules.md) | Formulas are folders with references, variables, outputs and modules (Terraform-style); state is the store |
| [0035](0035-adopt-outside-sessions.md) | Sessions run outside wisp (Claude Code, Codex, …) become wisp tasks: wisp adopt, hooks, Adopt in app/TUI |
| [0036](0036-my-stuff-and-apps.md) | My Stuff is data (store + blobs); apps and panes are sandboxed UI plugins, declarable as code |
| [0037](0037-hosts-for-peers-channels-and-keys.md) | Hosts for peers (loopback, machines HTTP client), the channels hub, API keys at the edge |
| [0038](0038-share-through-wisp-cloud.md) | One Share for everything (tasks, setups, stuff, apps, plugins), wisp Cloud by default, file/gist/git always available |
| [0039](0039-docs-site.md) | docs.trywisp.dev: Diátaxis structure, App/TUI/CLI/SDK tabs, generated reference, tested examples, llms.txt, Starlight |
| [0040](0040-meet-users-where-they-work.md) | Every feature reachable inside wisp and from the user's own harness (MCP + skill), git, CI, editors, chat; passive by default |
| [0041](0041-grid-is-the-hub.md) | The grid is the hub: shared things (gallery, teams, grid:// modules) and remote machines usable from GUI, TUI, CLI, SDK, MCP |
| [0042](0042-swappability-of-new-features.md) | Every feature added since 0003 is its own plugin with points a user plugin can fill (history, share, resources, workflows, …) |
| [0045](0045-grid-mail-dns-resolver.md) | Grid mail checks DKIM itself against the signer's DNS, with hickory-resolver (the one new dependency) |
| [0046](0046-plugins-installed-at-runtime.md) | A user's plugin is installed while wisp runs (a folder or a git URL, `user.` ids), off until switched on |
| [0047](0047-sandboxes.md) | Sandboxes are their own plugin (wisp.sandbox): one owner each, deleted with it; /sandbox, delegates, crew jobs, judges |
| [0048](0048-untrusted-plugin-tier.md) | Anything downloaded is an untrusted plugin: its UI is described (kit descriptors from a Worker in a sandboxed frame), its calls checked as itself |
| [0050](0050-env-values-masked-on-the-server.md) | .env values are masked on the server (wisp-envmask, the `kernel.egress` row view, `runtime.unmasked` for Reveal), never only in the page |
| [0051](0051-task-topic-is-a-turn-window.md) | A task's topic is a window (latest 8 turns whole, older ones as stubs; `/turn/<id>`, `/turns`, `/all`), read by an additive `TopicReader`; a change to a stub goes as the stub |
| [0052](0052-crew-shares-through-the-share-plugin.md) | A crew is shared through wisp.share as a `crew` link (no gist, no GitHub token); import still reads v1 gists; `crew:share` and `crew:propose` are their own permissions |
| [0053](0053-a-tasks-folder-is-ready-before-each-turn.md) | A task's folder is made ready before each turn (additive `runtime.run@1` `ready`, before `before:run`); a folder that can't come back refuses the turn; Keep worktree is respected on archive |
| [0054](0054-other-plugins-data-about-a-task-is-env-masked.md) | Other plugins' data about a task is .env-masked as it leaves: `runtime.envmask@1` service used in each plugin's own `kernel.egress` view (`goal_run`), a turn's other `ext` slots and its prompt masked with kept ranges (`#ext`) |
