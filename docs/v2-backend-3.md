# Backend round 3: the channels grammar (v1 grammar.js, lists.js, mentions.js) and conversation.rs

## Built

- `plugins/channels/core/src/grammar/` (was a 1-line stub):
  - `read.rs`: reading the options at the front (`@crew`, `#project`, `in`, `on`, `with`, a mode before `:`),
    v1's `token`, `pickName`, `readPlace`, `readWith`, `readMode`, `optionsToColon`.
  - `resolve.rs`: machine → project → model (the machine decides which models are valid), a member's job
    (model, level and mode for that job; never its harness or place), Auto.
  - `mod.rs`: `parse_message`, `parse_route` (wisp Grid's router: `on <computer>` only, whole names),
    `strip_formatting` (Telegram, Slack, Discord markup), `find_project`.
- `plugins/channels/core/src/lists.rs` (was a stub): help (yours, and one with nothing of yours for a place
  others read), projects, models, crew, machines, status, `refusal`, `model_label`, `ack_task`, `ack_crew`.
- `plugins/channels/core/src/mentions.rs` (was a stub): `crew_mentions` (page form `@[Ada](crew:id)` and
  plain `@Ada` / handle), `handle_of`.
- `conversation.rs` is compiled now (`pub mod conversation` in lib.rs): it was written against these and
  never built. It builds unchanged.
- Tests:
  - `tests/grammar.rs` › `every_message_of_v1s_table_reads_the_same`: **all 149 rows of v1's
    test/channel-grammar.test.js TABLE** (`tests/fixtures/grammar-table.json` is that TABLE and its ctx,
    extracted once with node from the v1 file; regexes kept as regexes), plus v1's named cases:
    `every_option_reads_the_same_in_any_order`, `the_machine_decides_the_model_wherever_on_stands`,
    `a_model_on_two_harnesses_with_no_default_among_them_is_ambiguous`,
    `in_a_thread_only_with_a_mode_and_crew_are_options`, `find_project_takes_the_exact_name_then_a_prefix_then_anywhere`,
    `each_channels_markup_goes_before_the_grammar_reads_it`, `a_router_reads_on_a_computer_and_nothing_else`.
  - `lists::tests` (3), `mentions::tests` (1). `cargo test -p wisp-channels-core`: every target passes.
  - `cargo clippy -p wisp-channels-core --all-targets -- -D warnings`: clean (three functions keep v1's
    one-letter names, with an `allow` saying so).
- v1 bug fixed (in docs/v1-bugs-fixed.md): `@Ada` matched inside `@Ada Lovelace`, cutting the leading mentions.
- regex as a dev-dependency of wisp-channels-core (already a workspace dependency).

## The flow wired: `chat.message` fires, Telegram reads the grammar

- **Layers:** a transport may use only `wisp-channels-api`, so the pure pieces a transport needs moved there:
  `api/src/conversation.rs` (the `Conversation` trait, `refusal`, `failed_line`, `first_part`, the fixed lines)
  and `api/src/markup.rs` (`strip_formatting`, `Markup`); core re-exports both. `ChannelHub::converse` (additive,
  default "this hub reads no messages") runs wisp.channels' flow; the channels host implements it with
  `wisp_channels_core::conversation::converse`. `Conversation::list(p, text)` now gets the list rendered by the
  flow (default: said), since `lists` is core's.
- **`KPhone::context`** fills the grammar with real data: projects (the default is the first), this computer's
  harnesses (`runtime.agents`, also as the adapters), the crew (`crew.list`), Auto's goals
  (`wisp_router_api::GOALS`), the running/waiting tasks. Manifest + `runtime:agents`, `crew:read`, `telemetry:track`.
- **`KPhone::count`** → `channel_event` telemetry (kind, and detail when the catalogue lets it through).
  Coverage row now `telemetry:channel_event`.
- **Telegram:** `telegram.options` on → `conv.rs` `TgConv` through `hub.converse` (v1 `#withOptions`: a private chat
  may ask for Full auto, a group for Edits at most; lists posted as they are, status through `say`; a reply to a
  task's message is its thread; a reply to a message no longer linked says so). Off → the classic path, which now
  also calls `heard`, so triggers on `chat.message` hear the linked chat either way.
- Tests: `tests/conversation.rs` › `a_message_through_the_door_is_heard_by_triggers_and_starts_its_task`,
  `a_list_a_refusal_and_full_auto_past_the_cap_start_nothing`, `in_a_tasks_thread_a_message_follows_up_and_stop_stops_it`;
  telegram `conv::tests::only_a_private_chat_may_ask_for_full_auto` (all pass).
- `cargo clippy -p wisp-channels-api -p wisp-channels-core -p wisp-channels -p wisp-telegram --all-targets -- -D warnings`: clean.
- `node tools/check/index.ts --rule=v1-coverage`: 0 errors, 64 todo.

## Not yet

- Slack (Socket Mode on the WebSocket client), Discord, GitHub-comments and email transports on this flow.
- v1's lists tests after the TABLE (exact texts, `ranInstead`, `modelNote`) beyond what's ported.
- **For the UI coder:** Settings → Phone → Telegram's "Read messages like the launcher" switch writes
  `options: true` on the telegram channel config (`channels.update`).
