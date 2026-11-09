# v2 round, item 4: rest of the backend

## Built

- **The uiOnly rule in `tools/check` (`rust-mcp`, ADR-0040).**
  - A command a manifest lists, but that its host registers nowhere, isn't in the catalogue, so it's no MCP tool. That's an error, unless it says `"uiOnly": "<a sentence why>"`.
  - The type → id map is per plugin, because `List` and `Create` repeat across plugins, and it reads `use … as …` aliases.
  - The repo passes it with 0 findings. Fixture test: `rust-mcp: a listed command its host never registers…`.
- **The settings into the registry.** `worktrees.cleanup`, `worktrees.max`, `worktrees.onDone` and `worktrees.projectAsk` are declared now, with v1's values.
  - They were read through `ctx.setting`, which answers only for a declared key, so they always read as unset.
  - `cleanup` keeps no default: unset means "never chosen", and its clock starts at the upgrade, as in v1.
  - Test: `worktree_settings_are_in_the_registry`.
- **Setup "changed since" and harness versions (ADR-0029).**
  - The first run records the harness's version (its `detect`, once per process per harness). Each MCP server's probed version is kept as the latest seen by name.
  - `runtime.setup` adds `harnessChangedSince` and each server's `changedSince` ("1.4.0 → 1.6.0"), and `wisp task setup` prints them.
  - `runtime.agents` refreshes the harness versions.
  - Test: `changed_since_compares_what_a_task_had_with_what_is_there_now`.
- **Task and My Stuff mentions in prompts** (v1 `agentPrompt`).
  - Before a run, `@[Title](wisp:<id>)` becomes `@Title (wisp task <id>)` with a note on each task: how to read it with `wisp_session`, or its latest report inline for a harness without wisp's tools.
  - `@[Logo](stuff:<id>)` brings what `stuff.describe` says (its path, a doc's text) in a `<wisp-stuff>` block.
  - The saved turn keeps the user's words. The runtime host got a generic `Host::command` to ask another plugin by command id.
  - Test: `the_session_tool_sits_beside_the_ask_tool`.
- **The update host (`wisp.update`).**
  - The check: 5 s after start, then once a day (looked at every 30 min), and `update.check`. npm dist-tags or GitHub Releases, through the net service.
  - `update.install`: npm or Homebrew through proc, then the updated `package.json` must say a newer version. npx has nothing to install.
  - The `update.state` row on `plugin:wisp.update:state`, with `checked_at`, `checking` and `running`, as the Updates pane reads it. The `update.updateChannel` setting.
  - **Bug found and fixed:** a debug build with a shared `CARGO_TARGET_DIR` (AGENTS.md's setup) was detected as an npm install and offered `npm install -g`. It now counts as a clone.
  - Tests: `a_build_of_this_clone_never_offers_an_update` and `manifest_is_valid`.
- **Telemetry from the owning plugins:**
  - `stuff_save` (kind, by, update), `stuff_publish` and `stuff_launch` from wisp.stuff;
  - `ship` and `merge` from wisp.ship;
  - `update` from wisp.update;
  - all fire-and-forget through `telemetry.track`. `app_started`, `turn_*`, `agent_login`, `resume_later` and `shell` were already sent.
- **The load guard (`wisp.machine`, v1 server/load.js).**
  - A sample every 10 s: macOS `kern.memorystatus_level`, else `vm_stat`, with `vm.loadavg` and `pmset -g batt`; Linux `/proc/meminfo`, PSI and `/proc/loadavg`. All through proc or async fs.
  - The core's hysteresis runs against the four knobs, now settings (`machine.memoryFloor`, `.cpuCeiling`, `.maxRuns`, `.batteryHold`), and the pause.
  - It provides `machine.service@1` (hold, busy, short, reading), plus `machine.load` and `machine.automations.pause`, and emits `machine.load_free` when a hold lifts.
  - Tests: `the_guard_holds_under_the_memory_floor_and_lets_go_with_a_margin` and `manifest_is_valid`.
- **The WebSocket client.**
  - `wisp_channels_core::ws`: RFC 6455, sans-IO. The handshake accept (with a small SHA-1, because `sha2` has none), masked client frames, and a decoder that joins fragments, passes pings through, refuses masked server frames, bad UTF-8 and oversize messages, and closes once.
  - `wisp_channels::ws::KWs`: reqwest's HTTP/1.1 upgrade (TLS included); it answers pings and closes once. It replaces the `NoWs` stub, with no new dependency.
  - Tests:
    - `the_handshake_accept_is_rfc_6455s`;
    - `client_frames_are_masked_and_server_frames_decode_across_reads` (RFC vectors);
    - `fragments_join_and_control_frames_come_through`;
    - `a_broken_server_is_closed_with_why`;
    - `the_websocket_client_talks_to_a_server` (a raw TCP server; run 3×, no race).

- **The Telegram transport (`wisp.telegram`, v1's classic path).**
  - Long-polls `getUpdates`; the offset is saved before each update is handled, so a `/new` never starts twice.
  - Links one chat with the one-time code, compared in constant time.
  - Buttons are signed taps (`encode_tap`), verified with the hub and acted on, and the keyboard goes once used.
  - A reply to wisp's message answers or follows up its task (message ids kept in the task's `remote.tg`, the last 20).
  - `/new [@project] <task>` (refused when it arrived more than 10 minutes late), `/projects` and `/help`.
  - Forwards never run, and the hub's rate gate applies. What's sent goes through the scrub.
  - Tests: `manifest_is_valid` and `a_chat_id_reads_as_text_either_way`. The flows have no test with a fake hub yet.
- **Layers:** `policy`, `scrub` and `secrets` moved from wisp-channels-core into wisp-channels-api (`git mv`, re-exported from core), so a transport plugin reaches them through the api, as `rust-layers` requires.

Clippy `-D warnings` is clean on wisp-worktrees, wisp-runtime, wisp-update, wisp-stuff, wisp-ship, wisp-machine, wisp, wisp-channels(-api, -core) and wisp-telegram. `npm run check` reports 0 errors.

## What's left in item 4

- **The channels grammar, lists and conversation: the blocker for the remaining transports.**
  - `plugins/channels/core/src/grammar/mod.rs` and `lists.rs` are 1-line placeholders.
  - `conversation.rs` isn't a module of wisp-channels-core's `lib.rs`, so it isn't compiled: `converse` is dead code. That includes the `Phone::heard` call item 1 put in it, so **`chat.message` triggers can't fire yet**.
  - Porting v1 `channels/grammar.js` (487 lines), `lists.js` (127) and `conversation.js` (200), with their tests, is what Slack, Discord, GitHub comments, email and Telegram's `options` all wait on. It should be the next channels job.

- **The transports.**
  - Telegram's `options` path (plain text as the launcher) needs the channels grammar and lists, which are placeholders in wisp-channels-core. Its webhook on a cloud box (through the grid's inbox) isn't wired.
  - Slack's core is ported, but its host (Socket Mode on the new WebSocket client) isn't wired.
  - Discord and email have no core yet. GitHub's channels transport (mentions, issue replies) isn't ported.
  - `chat.message` triggers (item 1) fire once a transport calls `converse`.
- **The computer pane's process view.** `machine.read` (the process table, attribution to tasks, history), `machine.stop`, `machine.fix` and `machine.harness.clean` aren't wired. The heavy-step lock needs a caller design: who takes it (workflow steps? crew jobs?).
- **Update relaunch.** After an install the row says "restart wisp to use vX". v2 has no shutdown service a plugin can ask to restart the server, and the desktop app's download-and-swap belongs to `apps/desktop`.
- **More telemetry:**
  - not yet sent: `takeover`, `fork_task`, `btw`, `side_task`, `move_task`, `compact`, `retro`, `delegate`, `ask_user`, `approval`, `crew_tool`, `crew_imported`, `crew_shared`, `connector_tool`, `channel_event`;
  - `task_share` and `task_import`, and `wisp_*` from MCP tools beyond `wisp_session(s)`.
- **The copilot session reader:** the Copilot CLI isn't installed on this Mac, and copying the user's own `~/.copilot` sessions is ruled out, so it stays listed.
- **An existing rule break, not fixed here:** `plugins/runtime/host/src/setup.rs` `available()` has `if harness == "claude"` (outside skills by hash). It belongs behind a harness point.
