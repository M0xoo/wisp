# Backend round 5: the check fixes, grid sites

## Fix first (`npm run check`)

- **rust-mcp, connectors (8):** the commands *are* registered: connectors' pane registers them with its own
  `on!(api::List, |p, ctx, a| …)` macro, a form the rule didn't read. The rule now reads a macro whose first
  argument is the command type followed by a closure. Fixture case added (`shop.sell` through `on!(api::Sell, |…| …)`)
  in `tools/check/test/rust.test.ts` › `rust-mcp: …` (pass).
- `rust-mcp` moved to its own file, `tools/check/rules/rust-mcp.ts` (rust.ts had gone past 400 lines);
  `rules/rust.ts` re-exports it, `RUST_RULES` unchanged.
- **rust-resource-kinds, learn and worktrees:** both are data, not setup, so each host now says
  `resources: data-only (why)`: learn's tables are what retros learned and you edited (its on/off is the
  `learn.enabled` setting); worktrees' are Settings → Worktrees' rows (its setup is the `worktrees.*` settings and
  a project's `worktree:` policy).
- **rust-manifests test (found red, not mine):** the rule now refuses a host crate that isn't a plugin (main's
  change), the test still expected the fixture's "not a plugin yet" stub to pass. The test expects the two
  findings now, as the rule's own comment says ("every host crate is a plugin").
- `node --test tools/check/test/rust.test.ts`: 10/10. `npm run check`: the 10 errors left are all UI
  (packages/ui CSS: off-scale `76px`, `flex-wrap` outside Wrap, an `:is()` list; `@wisp-plugin/issues-ui` and
  `learn-ui` registered nowhere; `StuffPage.tsx:82` fetch outside the client): the UI coder's.

## Grid sites (published My Stuff apps)

- `apps/grid/src/sites.rs` (was a stub; v1 grid/sites.js + server/bundle.js): the bundle (`unpack`, `pack`,
  `bundle_path`, `private_file`, `public_file`), `site_slug`, `is_site_label`, `app_file`, `type_of`, and `Sites`:
  `publish` (a new version unpacked beside the old one and swapped in; secrets and source maps dropped on receipt;
  the per-user cap; a second app with the same title gets `-2`), `remove`, `remove_all`, `list`, `by_label`,
  `serve` (GET/HEAD only, no dotfile but `.well-known`, `x-robots-tag: noindex`, nothing outside its folder).
- Edge (`apps/grid/src/edge_sites.rs`): `GET /api/sites`, `PUT /api/sites/<key>?title=&entry=` (the body read up to
  the sites' own cap, before the root's 16 MB read), `DELETE /api/sites/<key>`; device token or session
  (`grid:publish`). The `<slug>--app--<handle>` host serves the app; `HostLookups::site` finds it.
- Tests (`apps/grid/src/sites/tests.rs`, v1 test/grid.test.js's cases):
  `an_app_gets_a_public_link_updated_in_place_and_unpublished_only_by_its_owner`,
  `a_bundle_reaching_outside_its_folder_or_without_its_entry_is_refused`,
  `the_grid_keeps_secrets_out_of_a_published_app_whatever_an_older_wisp_sent`,
  `a_slug_is_a_dns_label_part_and_never_a_preview`,
  `an_account_has_at_most_its_apps_and_a_second_one_with_the_same_title_gets_its_own_link` (all pass).
- **Not yet:** an app's own database (`/_wisp/…`, v1 app-db.js: 404 for now); a box publishing as its user (the
  `Box` credential carries no user yet); removing an account's site files when the account goes (the grid has no
  account removal path yet).

## Publishing from wisp (the other half: nobody provided `stuff.publish@1`)

- **stuff:** `stuff.bundle {id} → {title, entry, files, size, body}` (new, `plugins/stuff/host/src/bundle.rs`; the
  body is base64 of the bundle): an app's files packed by My Stuff, which owns them, private files left out
  (`wisp_stuff_api::app::private_file`). Manifest entry. After `stuff.publishApp` / `unpublishApp`, stuff re-reads
  its own item (the publisher recorded the link): one line each in commands.rs. Test:
  `bundle::tests::a_bundle_is_length_header_bytes_per_file`.
- **grid-client** provides `stuff.publish@1` (`plugins/grid-client/host/src/publish.rs`; v1 services/publish.js):
  `targets` (the grid signed in to), `publish` (`stuff.bundle`, `PUT <grid>/api/sites/<id>?title=&entry=` with the
  device token, then `stuff.setPublished {url, account, host, handle, at}`), `unpublish` (`DELETE`, then clears it;
  signed out: clears it and says to unpublish from the account page). v1's words for an older grid (404), a lost
  sign-in (401) and the grid's refusals. Manifest: `provides stuff.publish 1.0.0`, + `stuff:publish`. Test:
  `publish::tests::the_grids_answer_says_an_older_grid_a_lost_sign_in_or_its_refusal`.
- `cargo clippy -p wisp-grid -p wisp-grid-client -p wisp-stuff -p wisp-stuff-api -p wisp-learn -p wisp-worktrees
  --all-targets -- -D warnings`: clean.
- **For the UI coder:** My Stuff's Publish shows `published.url` (open, copy) and Unpublish; `stuff.targets` lists
  the grid it would go to.

## Grid inbox (channels reaching a sleeping box)

- `apps/grid/src/inbox.rs` (was a stub; v1 grid/inbox.js): per user and channel one unguessable URL (`url_for`, the
  token sealed in the user's secrets, the same URL each time, `rotate` for a leaked one, `by_token`); `accept`
  keeps only the headers the box checks, holds the rest (caps: rows, bytes, `BODY_MAX`; over them dropped and
  counted, still a 200), answers a live request (Slack's URL check) only from a box that's up and never wakes one,
  skips what no box acts on (Slack's edits and its own replies); `drain` delivers strictly in order (nothing passes
  a row being retried), wakes the box (earned: after `wake_strikes` wakes with nothing accepted, a scheduled wake
  behind a gap), finishes on 2xx/4xx, backs off on anything else and drops after 5 tries; the box is told what was
  lost; `sweep` takes what's past its hour (counting what never arrived). `event_key`: the channel's id (or the
  body's hash) with its headers' hash, so a sender's retry is one row and a forged id can't swallow the real one.
- Delivery (`HttpDeliver`): `POST http://127.0.0.1:<port>/api/cmd {cmd: "channels.inbound", args}` with the box's
  proxy secret and the row's key as the Idempotency-Key; the transport's own status and body come back.
- Edge (`apps/grid/src/edge_inbox.rs`): `POST <handle>.<domain>/_in/<token>` (another user's token, or off: 404),
  delivered behind the answer; `GET /api/channels/url?channel=`, `POST /api/channels/rotate {channel}`
  (`grid:channels`: the box or its owner). A restart drains everyone with something held; a sweep every minute.
  Off unless grid.json's `channels.enabled` is true.
- **`Box <handle> <secret>` is checked now:** the edge read any `Box …` header as a box, with no user. It's the
  running box's own secret (constant-time), resolved to its user (`Who::Box(UserRow)`), else nobody. So a box can
  ask for its own channel URLs and publish apps as its owner.
- Tests (`apps/grid/src/inbox/tests.rs`): `a_message_to_a_sleeping_box_is_held_then_woken_and_delivered_in_order`,
  `a_senders_retry_is_one_row_and_a_refusal_from_the_box_is_finished`,
  `a_box_that_fails_is_retried_with_backoff_and_nothing_passes_it`,
  `over_the_caps_a_message_is_dropped_counted_and_the_box_told`,
  `a_live_check_reaches_only_a_box_that_is_up_and_never_wakes_one`,
  `wakes_are_earned_after_strikes_the_next_is_a_scheduled_one_behind_a_gap`,
  `a_held_message_past_its_hour_is_gone_and_counted` (all pass). `cargo clippy -p wisp-grid --all-targets -- -D warnings`: clean.
- **Not yet:** Discord's edge (answering an interaction's PING itself with the box's public key: Discord's messages
  are held but its PING isn't answered while the box sleeps); the box side asking for its URL (channels' `BoxApi`
  is still `NoGrid` in the channels host).

## Grid routes (`on laptop` through the grid's own bot)

- `apps/grid/src/route.rs` (was a stub; v1 grid/route.js): `set` (the bot's token and who may route, checked;
  `getMe`, then the grid's own webhook URL and secret, sealed first; the old bot's webhook deleted), `remove`,
  `view` (never the token or the secret), `check` (the webhook's secret, constant time), `take` (decided before
  Telegram's 200: a retry stops at its key; only a listed person in a private chat, never a forward; a reply to
  what the grid sent in a thread is a follow-up to the same computer; else `parse_route` from the channels
  grammar: `on <computer>` first, whole names, two that share a name refused), `run` (one try through the
  tunnel, the person hears whatever comes of it: offline, no answer, an older wisp, a refusal, or the reply),
  `reply` (a computer's report, to that thread's chat, only from that computer, the thread ref signed), `sweep`.
- Edge (`apps/grid/src/edge_route.rs`): `POST <domain>/_route/<token>`; `GET|PUT|DELETE /api/channels/route`
  (session only: the bot is the person's own); `POST /api/channels/reply` (device only). The edge now drops
  `x-wisp-route` from every request it forwards to a computer: only the grid's route sets it.
- **The computer's side:** grid-client's tunnel server hands a request marked `x-wisp-route: grid` to
  `channels.routed` (never to wisp's HTTP as the user); `plugins/channels/host/src/routed.rs` runs it through the
  grammar flow with the task's thread kept (`remote.routed`) for follow-ups, if `channels.acceptChannels` is on
  (new setting, off by default; v1 `acceptChannels`, its coverage row now a setting). grid-client + `channels:routed`.
- Tests: route `the_bot_is_set_with_a_webhook_of_the_grids_own_and_a_bad_token_or_sender_is_refused`,
  `on_laptop_goes_to_that_computer_and_its_answer_back_to_the_chat`,
  `only_a_listed_person_in_a_private_chat_may_route_and_anything_else_gets_a_line`,
  `a_report_reaches_the_threads_chat_only_from_the_computer_it_went_to`, `a_bot_token_and_senders_are_checked`;
  channels `routed::tests::a_routed_message_is_refused_unless_this_computer_accepts_channels` (all pass).
- `cargo clippy -p wisp-grid -p wisp-grid-client -p wisp-channels --all-targets -- -D warnings`: clean.
- **Not yet:** a routed task's later report back to the chat (grid-client posting `/api/channels/reply` when its
  task ends); the box holding the same bot (v1 `botMark`); `acceptChannels` refused when set from a phone (v1
  allowed it only at the computer). **For the UI coder:** the grid account page's routing form (bot token, ids),
  and Settings → Phone → "Accept tasks from channels" (`channels.acceptChannels`).

## Settings (coverage rows)

The first coverage pass called 21 v1 settings missing; several had a v2 home under another name. Checked each one
in the code before remapping, and built two that were declared but never acted on:

- **Built:** `ship.fixConflicts` (v1 `fixConflicts`): `Ship::set_auto_fix` existed and nothing called it; the PR
  tick now reads the setting each look (`true` or v1's `"on"`). Test `tests::fix_conflicts_is_off_unless_switched_on`.
  `git.maskEnvFiles` (v1 `maskEnvFiles`): `git.changes` masks `.env` files unless the setting is off, whatever the
  caller asked. Test `tests::env_files_are_masked_unless_switched_off`. Both declared in their manifests, + `settings:read`.
- **Remapped (verified acted on):** `harnessAsk` → `cmd:accounts.watch.ask`; `goalJudges`, `goalVote` → the `goal` kind
  (a task's goal without its own judges uses it); `editor`, `terminal` → the device's `ui` kind; `worktree` → the
  `projects` kind's `worktree.enabled` (read at create).
- `channels.acceptChannels` (above) is the third new one.
- **Still work (14 rows):** `apps`, `blocks`, `cloneDir` (the project policy's `dir` isn't read), `drainWatch` (the
  budget kind has the field; the drain watch isn't wired), `followUp`, `leanRuns` (its rules are in runtime core;
  nothing calls them), `limitHold`, `limitWait`, `liveLimits`, `subagentModel`, `subagents`, `terminalSessions`,
  `watch`, `webhookTriggers`, `windowNotice`.
- `node tools/check/index.ts --rule=v1-coverage`: 0 errors, 55 todo (was 64).

## Mail: not this round

v1 grid/mail.js checks SNS signatures against AWS's certificate, verifies DKIM with DNS TXT lookups (the grid has no
DNS resolver dependency yet: a new one needs an ADR line), parses MIME and sends replies through SES (SigV4). It's
its own round; `mail.rs` and `dkim.rs` are still stubs.
