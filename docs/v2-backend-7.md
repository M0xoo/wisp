# Backend round 7

## 1a. A run at its usage limit (v1 runner.js `#atLimit`, `#waitsForReset`, index.js:494 `waitAtLimit`)

Nothing in v2 told a usage-limit end from a failure: the turn showed "Fake CLI failed" and `later.waitAtLimit` had
no caller.

- **`Turn.limit: Option<TurnLimit { account, until, others[{id, label, kind}], kind, extra, waiting }>`** (runtime
  api, additive; JSON body, no migration). Bindings `runtime/TurnLimit.ts`, `LimitAccount.ts`, `Turn.ts`.
- **runtime host `limit.rs`**, from `finish.rs` `end_turn` (an error, not stopped, not a subagent's run; before the
  refusal check, which no longer runs at a limit):
  - `router.service@1` `classify` reads the error (scope `agent`, not `device`); no router service: no card.
  - `budget.resetAt` (new read command, v1 `budget.resetAt`) says when; else what the error said (an hour).
  - `accounts.cool` (new, accounts api + host, additive; several accounts only) marks this account until then and
    answers the list: the label for the hero, and `others` = the ready ones, never this one. wisp never switches.
  - `extra` from the harness's `accounts()` spec (the provider's own way past a limit).
  - The hero "<account label | harness name> is at its usage limit" (`blocked`), the CLI's words in a `terminal`
    block (runtime core `limit.rs` `at_limit`).
- **Wait for the reset** (`runtime.limitWait`, bool, off): when nothing else holds the task, it lands quietly in
  Done (nobody pinged), `limit.waiting`, the hero "It carries on by itself after the reset…" (`partial`), and
  `later.waitAtLimit {sessionId, at: until, agent}` is called once the task is saved. Later refuses (five already
  waiting, ten in a row): the task goes back to Needs you, unread, with the card.
- Permissions: runtime + `budget:read`.
- Tests: runtime core `limit::tests::a_run_at_its_limit_shows_who_until_when_and_what_else_it_can_do`; lifecycle
  `a_run_at_its_usage_limit_gets_its_card_and_waits_for_the_reset_when_settings_say` (off: the card, Needs you,
  `accounts.cool` asked with the reset; on: Done, not unread, waiting, later asked; later refusing: back in Needs
  you). Both pass. The Recorder answers other plugins' commands now (`answers`, `asked`).
- Not ported: v1's `#deviceLimit` (too many devices signed in: a different card), the extra-usage link's wording on
  the card (the UI's).

## 1b. Check Codex while work waits (v1 live-limits.js)

- **`budget.liveLimits`** (bool, off). budget host `live.rs`: each minute's tick, for every Codex account with work
  held on it, a read every 10 minutes through `accounts.limits` (Codex's app-server, nothing spent) →
  `codex_live` + `codex_banked` → `record` (a window that reset early frees the held work). A failed read waits
  10, 20, 40 min… up to hourly (`live::next`). Permission `accounts:read`.
- Test: `live::tests::a_read_comes_every_ten_minutes_and_less_often_while_it_fails` (pass).
- Not ported: v1's one read before held-back work when the last reading is over 15 min old (`before()`: the
  `before:run` guard is synchronous here), and work waiting on `later.waitAtLimit` entries counting as waiting
  (only `budget`'s own held turns do).

- Clippy on budget, budget-api, runtime ×3, accounts, accounts-api (all targets): clean.

## 1c. Ask near the limit (v1 web/js/limit-hold.js, server/guard.js)

- **`budget.limitHold`** (enum off | 80 | 90 | 95, default 90, as v1).
- **budget core `ask.rs`** (sans-IO): `line`, `next_line` (after a yes: 95%, 99%, then not until the reset),
  `spread` (p50/p75/p90 of the newest 50), `units` (first turns vs follow-ups; a follow-up at least this task's
  median; a subagent's, wisp's own rounds and compactions never count), `rate` (the learned rate, capped by the
  window's whole use over wisp's units in it), `windows`, `hold_for` (the window nearest its limit), `hold_to`,
  `message` (v1's words, with `confirmLimit` / `--yes`), `until`.
- **budget host `ask.rs`**, in the `before:run` guard after Automations stop at:
  - yours: **refused** (`Veto`, code `budget_hold`, the message), unless the run says `confirmLimit`: then each
    window it crosses is acked (`Budget::ack`), so it asks again only higher up or after the reset;
  - an automation's (`by` crew, trigger, automations, agent, goal, review): **held** (`held.kind = "ask"`, its
    window, where it would end up, the line, the why) until the window's reset (or an hour), then released by the
    minute's tick (`runtime.release`);
  - runs going on the account count at half their estimate (in flight from the guard to `turn.ended`).
  - What it learns from: every `turn.ended` (newest 200 per harness within 30 days), saved in `budget_meta`
    (`runs`), so a restart keeps the estimates.
- **Contract (additive):** `StartArgs.confirmLimit`, `FollowUpArgs.confirmLimit` (carried on the queue item's
  `opts`), `BeforeRunCtx.confirm_limit`; `TurnEnded.first`, `TurnEnded.inner`. The CLI's `--yes` sends
  `confirmLimit` on `wisp <prompt>` and `wisp reply`.
- Tests: core `ask::tests::a_run_that_would_cross_your_line_is_asked_about_and_a_yes_moves_the_line_up`,
  `ask::tests::the_estimate_is_what_runs_like_this_took_and_a_follow_up_at_least_this_tasks_median`; host
  `ask::tests::every_run_that_did_work_is_learned_newest_200_within_30_days` (all pass). Clippy on budget, budget
  core, runtime ×3, wisp: clean.
- Not tested end to end: the guard itself (budget host has no kernel rig; a `crates/wisp/tests/serve_budget.rs`
  case with a fake harness reporting cost and windows is the place, outer loop).
- Not ported: v1's own-history per schedule / trigger / crew job (`originKey`: five runs of one automation count on
  their own), and the page's own pre-send hold (GET /agents `est`; the UI reads the veto's message for now).
- Coverage: limitHold, limitWait, liveLimits → settings rows (39 todo).

## 2a. A test hub for transports (`wisp_channels_api::testing`)

- `TestHub` (a `ChannelHub` with no kernel and no network): `ScriptNet` (HTTP answered by URL substring, every
  request kept; `sent(needle)`), `ScriptWs` (each `connect` takes the next scripted socket; `quiet()` plays a socket
  that looks open and says nothing; what's sent is kept), `TestPhone` (a fixed context; counts and heard messages
  kept; nothing starts), configs, remotes, marks, `started`, warnings, `on_box` (plays a cloud box), sleeps that
  return at once and advance `now` (past 64 the hub's `stop` is cancelled, so a dial loop ends), `spawned` work run
  by `run_spawned`, and `converse` recorded (`conversed`), saying `reply` through the door and acking a thread with
  `start_as` as the task. Sans-IO like the rest of the api crate.
- **`WsConn::ping() -> bool`** (additive, default true): sends a ping and says whether anything came from the server
  since the last beat. The host's client (`channels/host/src/ws.rs`) tracks bytes heard; the codec now hands a
  pong back (`Event::Pong`, was swallowed).

## 2b. Slack, finished (v1 channels/slack.js)

- **Keep-alive:** after the hello, a beat every `slackPingMs` (30 s); nothing from Slack since the last one and the
  socket is closed ("Slack stopped answering.") and dialled again. Frames are read before any timer (`biased`): the
  test hub's instant sleeps showed the hello timer could win against a frame that had already arrived.
- **Buttons and clicks** (`click.rs`): a report's choices as signed buttons (answers; replies only when the task
  isn't in Full auto), plain text when Slack won't take the blocks; a click passes the door (a stranger's does
  nothing), is checked against its signature, answers through `hub.act`, and the message loses its buttons and gets
  "✓ … · <@user>" (`chat.update`, else a post in the thread). A forged or done button, or a reply on a Full auto
  task, tells only the clicker (`chat.postEphemeral`).
- **A cloud box** (`inbound`): `ready` needs the bot token and the signing secret there; `start` checks the bot
  token and marks; an event Slack posted to the box's grid URL is checked with the signing secret against when the
  grid took it (`sign::verify`), the URL check answers its challenge (a wrong secret is said in Settings), a repeat
  is dropped by its event id, and the work runs after the answer.
- Tests (all pass): `tests/socket.rs` › `a_linked_persons_mention_is_acked_read_by_the_flow_and_answered_in_its_thread`,
  `a_stranger_is_told_once_and_link_with_the_code_lets_them_in`, `a_dropped_socket_is_dialled_again_after_a_wait`,
  `a_socket_that_goes_quiet_is_closed_at_the_next_beat_and_dialled_again`,
  `a_signed_button_answers_and_says_who_and_a_forged_one_does_nothing`; `tests/inbound.rs` ›
  `a_signed_event_is_read_once_and_a_bad_signature_or_a_stale_one_is_refused`; `click::tests::a_reports_choices_are_signed_buttons_and_a_reply_only_outside_full_auto`.
- Clippy on slack, channels api, channels, channels core, telegram: clean.
- Left: one turn at a time per thread (v1 `Turns`), the box's own events URL in the manifest (`extra("manifest")`
  gives the computer's), a crew member's name on its reports (`chat:write.customize`).

## 2c. Discord on the grammar (v1 channels/discord.js, on a computer)

Both crates were placeholders.

- **`wisp-discord-core`** (sans-IO): `gateway::Conn` (hello → identify with no privileged intent, or resume with the
  session; the beat carries the last seq and a beat whose ack never came ends the socket; reconnect; an invalid
  session waits and, unless resumable, forgets the session), `gateway::closed` (4004, 4010–4014 won't come back;
  1000, 1001, 4007, 4009 end the session), `message::message` (no bots, webhooks, joins or pins; in a server only a
  mention of this bot), `snowflake_ms`, `invite_url` (v1's permissions), `unmask` (a link shows what it says),
  `backoff_ms`.
- **`wisp-discord`** host: transport `discord` (secrets `token`, `publicKey`): `GET /gateway/bot` (or the
  session's resume URL) → the hub's `Ws` (`?v=10&encoding=json`) → the beat on the hub's clock (first after a random
  part of the interval); a dropped connection resumes; three in a row with nothing and the resume URL is dropped.
  A message: `link <code>` in a DM links the person; the door (`policy::gate`, a snowflake's own time as the
  message's); then the flow (`conv.rs`: Edits at most, Plan when none named; in a server a thread is made on the
  asking message and the task answers there, in a DM as replies; the task keeps `{channel, thread, ids}`, so a
  mention in its thread or a reply to one of its messages follows it up). Reports go to its thread, or as a reply
  to its last message. What leaves pings nobody (`allowed_mentions: []`), shows no masked link, has no embeds.
  `channels.extra {channel: discord, what: invite}`: the invite link (coverage `GET /remote/discord/invite` →
  `cmd:channels.extra`; 38 todo).
- Tests (all pass): core `gateway::tests::hello_identifies_or_resumes_and_a_beat_without_its_ack_ends_the_socket`,
  `message::tests::only_a_persons_dm_or_mention_of_this_bot_is_read`, `tests::the_invite_asks_for_what_the_bot_needs_and_no_more`;
  host `tests::what_leaves_pings_nobody_and_shows_every_link_as_it_is`; `tests/gateway.rs` ›
  `a_linked_persons_mention_is_answered_in_a_thread_made_on_it`, `a_stranger_is_told_once_and_link_with_the_code_lets_them_in`,
  `a_dropped_connection_resumes_and_a_quiet_one_ends_at_its_unanswered_beat`. Clippy (both crates): clean.
- Not yet: `/wisp` (the slash command, its registration and autocomplete), buttons (interactions), a cloud box
  (interactions posted to the grid, ed25519-checked: core already depends on ed25519-dalek), REST rate-limit
  buckets (v1 `#learn`: a 429 is an error here), the identify spacing (one per 5 s).

## 3a. GitHub comments on the grammar (v1 channels/github.js)

- **`wisp_github_core::comments`** (sans-IO): `parse_repo` (https, ssh, scp, a token in the URL; github.com only),
  `wisp_command` (`/wisp …` on the first line, later lines kept; not in a code block, a quote or mid-line),
  `Cursor` (since + seen, 200, kept in the channel's config so a restart remembers), `comment` (yours only when you
  wrote it, not an app acting for you; wisp's own end in `<!-- wisp -->` and never run), `no_ping` (GitHub links
  `.@x` too), `split_include` / `header` / `http_status` (gh's output), `backoff_ms` (to 15 min, GitHub's
  retry-after wins), `iso_s` / `s_iso`, `body_out` (8000 chars, marked), `about` (the issue by reference: its text is
  untrusted), `fixed_line`, `report`.
- **Transport `github`** in `wisp-github` (`comments.rs`, contributed next to the CI trigger source): every
  `ghPollMs` (60 s) it looks at each repo a project on this computer has as its origin (20 at most, newest used
  first); the first look only sets the cursor; a `/wisp` comment from you goes through the door and the flow (Edits
  at most, Plan when none named; the issue `about` the agent; a public repo shows no lists and only the first part of
  a status or failure); the task keeps `gh: "repo#n"`; a task from wisp followed up there reports that one turn back
  (`ghOnce`). Reports: on a private repo (or `publicReports` on) the title, text and choices; on a public one
  "✅ wisp finished this." / "⛔ …" / "❓ …". `gh` and `git` through the hub's `Exec`; a 403/429 backs off.
- `wisp_channels_api::testing::ScriptExec` (the hub's processes from a script: the longest needle that fits).
- Tests (all pass): core `comments::tests::a_wisp_comment_is_read_and_everything_else_is_left_alone`,
  `comments::tests::a_comment_is_yours_only_when_you_wrote_it_and_wisps_own_never_runs`; `tests/comments.rs` ›
  `your_wisp_comment_is_read_once_and_answered_on_its_issue_and_nobody_elses`,
  `on_a_private_repo_the_report_says_what_the_agent_wrote`. Clippy (github, github core, channels api): clean.
- Not yet: a PR with no task of its own following the task on its branch (v1 `#threadOf`'s `headRefName`).

## 3b. Email on a cloud box (v1 channels/email.js)

Both crates were placeholders.

- **`wisp-email-core`** (sans-IO): `own_words` (v1's cuts: `-- `, underscores, "Original Message" in six languages,
  From/Sent headers, "Sent from…", wisp's own reply line, "On … wrote:" in seven; quoted lines), `html_text`
  (comments, head/style/script, up to a client's quote or signature: blockquote, gmail_quote, yahoo_quoted…;
  breaks, tags, entities), `mail_words`, `is_forward`, `is_reply`, `refs`, `clip_bytes` (30 000 bytes, between
  characters), `reply_subject`, `date_ms`, `is_address`.
- **Transport `email`** (`ready`: on, a sender, a grid): `start` asks the grid for this box's address and keeps it;
  `inbound`: who it's from only from the grid's `x-wisp-mail-from|dmarc|id` headers; `unproved` or no DMARC pass,
  another sender, no date: a 403 and silence (Settings says why); a repeat is answered 200 and not read; the rest
  through the door (the earlier of the sender's date and the grid's) and, after the answer, the flow: a reply to a
  task follows it with its own words only (never the subject), a reply to nothing wisp knows starts nothing, a new
  message reads its subject (unless forwarded) and its own words. Replies only ever answer a message the box took
  (`mail_reply`, "↩ Reply above this line…", subject `Re: …`); the task keeps every id of its thread (50). Reports
  go as a reply to its newest message. `view`, `update` (on/off, the sender; on needs a grid), `rotate` (a new
  address).
- Test hub: `on_box` mail replies are kept (`mailed`).
- Tests (all pass): core `tests::only_what_the_sender_just_wrote_is_read`; `tests/mail.rs` ›
  `a_message_from_you_starts_a_task_and_a_reply_follows_it_up`,
  `anyone_unproved_or_else_gets_a_403_and_a_stray_reply_starts_nothing`. Clippy: clean.
- Not yet: attachments (only the text is read; v1's first reply said so).

## 3c. Grid mail (v1 grid/mail.js, grid/dkim.js) and ADR-0045

`apps/grid/src/dkim.rs` and `mail.rs` were one-line stubs; the config (`mail`) and the tables (`mail_threads`,
`mail_sent`) were already there.

- **`dkim.rs`** (RFC 6376, RFC 8463): `header_fields` (the one reading of a header section: a bare CR or LF, a
  whitespace-only fold, a line that's no header, no end → unprovable), `tag_list` (a tag twice voids it),
  simple/relaxed canonicalization, `b=` emptied, and `verify(raw, txt, now)`: rsa-sha256 (1024 bits at least) and
  ed25519-sha256 only; `from`, `subject`, `date` must be signed; no `l=`; `i=` inside `d=`; `x=` not past; the key:
  one TXT record, `v=DKIM1`, its type, `h=` sha256, `s=` email, not `t=y`, `t=s` exact; at most 5 signatures, their
  lookups together. The lookup is injected (`Txt`): "no such key" is a result, a failure is `dns: true`.
- **`mail/mime.rs`**: `parse_mail` (latin1 bytes, MIME multipart to depth 8, base64 / quoted-printable, UTF-8 and
  Latin-1, encoded words in the subject; who it's from strictly: one From, one address, no groups or comments, a
  quoted name with an angle bracket is nobody, any of Subject/Date/Message-ID/In-Reply-To/References twice is
  nobody; a machine's mail flagged `auto`), `compose_mail` (every line decided here; a line break in a header
  refused; the subject flattened; `Auto-Submitted: auto-replied`).
- **`mail/ses.rs`**: SNS's `SignatureVersion` 2 (what's signed, in SNS's order), our topic only, 15 minutes at most,
  the key from `sns.<region>.amazonaws.com` (a `.pem`, https, nothing else in the URL) or pinned (`inbound.keys`);
  `read` (a subscription to confirm, or a received message sent whole: BASE64 is `exact`); SES's verdict is never
  `pass`; `send_request` (SES v2 raw, `SigV4` by hand, no SDK).
- **`mail/service.rs`** (`MailService`): the webhook (a bad signature 403; recipients by their address, the local
  part being the user's sealed token for `email`; a machine's mail, a bounce, our own domain: nothing; then the
  DKIM proof: `pass` only for a signature by the From's own domain, a DNS failure there is a 503 so SNS brings it
  back) holds one copy per user with the grid's own `x-wisp-mail-*` headers; `delivered` keeps the thread once the
  box took it (100 per user, `threadDays`); `reply` goes only to a thread's sender (a body naming an address is
  refused), at `sendPerHour`, scrubbed here too, threaded (`In-Reply-To`, `References`), through SES.
  `system_txt`: the system's resolver, 5 s a lookup (**hickory-resolver 0.26**, pinned in the root `Cargo.toml`;
  **ADR-0045** says why, and the alternatives). A dev grid may pin `dkimKeys`.
- **Edge** (`edge_mail.rs`): `POST /_mail/ses` (512 KB; what it holds is delivered behind the answer);
  `POST /api/channels/mail/reply` (the Box credential only, `grid:mail-reply`); `channels/url` and `rotate` with
  `channel: email` answer `{address}`. The inbox has an `email` channel and tells mail of each delivery a box took.
- **The box's side** (`channels/host/src/hub.rs`): `KBox` replaces `NoGrid`: on a cloud box (`WISP_GRID_URL`, the
  box's secret, its public URL; not a sandbox) the hub asks its grid as itself for a channel's URL or address,
  rotates it, and sends mail replies; `bot_mark` is a proof of the token (v1's). hostd now gives every box
  `WISP_GRID_URL`. So Slack's and email's cloud paths reach the grid.
- Tests (all pass): `dkim::tests::a_message_signed_by_its_domain_is_proved_and_any_change_is_not`,
  `what_leaves_doubt_is_refused`, `an_rsa_signature_is_checked_too`; `mail::mime::tests` (2), `mail::ses::tests`
  (2), `mail::date_tests` (1), `mail::service::tests::a_signed_message_by_the_froms_own_domain_is_held_as_pass_and_its_reply_goes_only_to_it`,
  `unproved_mail_is_held_as_such_a_stranger_address_holds_nothing_and_a_forgery_is_refused`; channels
  `hub::box_tests::a_cloud_box_asks_its_grid_as_itself_and_a_sandbox_has_no_channels`.
- `cargo clippy -p wisp-grid -p wisp-channels --all-targets -- -D warnings`: clean. `cargo deny check licenses bans`:
  ok. `npm run check`: 3 errors, all UI (`app-feed.css`, `app-task.css`, `issues/ui` Picker's setTimeout).
- Not yet: v1's `inbox.delivering` wait (a box's first answer racing its own 2xx), `set_channel_key` (the grid's
  edge doesn't check Discord's interactions for a box yet), the SNS certificate fetch path untested (pinned keys
  are; `key_of` reads a certificate too).

## 4. The TS and Python SDKs (ADR-0028)

`wisp-agents/client` still spoke v1's routes (`/sessions`, `/launch`…), which v2 doesn't serve (ADR-0031). Both
SDKs now speak v2's wire: every call a command (`POST /api/cmd`, an idempotency key per call, the same key making a
retry one command, `x-wisp-token` when set) or a topic (the sync stream `GET /api/events`, read only: `fresh=<topics>`,
proto 2), so permissions, idempotency and live updates behave as in the app.

- **TypeScript, `npm/wisp-agents/client.js` + `client.d.ts`** (zero dependencies): `WispClient.connect()` (the
  running wisp from `server.json`, or one started with `wisp serve`), `cmd(id, args, {key})`, `catalogue()`
  (`cli.catalogue`), `run`, `get`, `list`, `turns`, `presentation`, `followUp`, `stop`, `apply` (`resources.apply`,
  or `.plan` with `dryRun`), `events(topics)` (an async iterator of server messages), `wait(id, {until})` (one look,
  then one per frame on `session:<id>`: never a timer), `WispError {code, status, retry}`, `SseParser`,
  `decodeFrame`, and **`generateTypes(catalogue)`**: a `.d.ts` typing `cmd` for every command the running wisp lists
  (its args' TS types come from ts-rs through the catalogue; ui-only commands left out).
- **Python, `sdk/python/`** (package `wisp`, stdlib only, Python ≥ 3.9, `pyproject.toml`): `wisp.connect()`,
  `cmd(command, args, /, key=…, **kw)`, `call.<plugin>.<command>(**args)` (any command by its id), the same task
  helpers (`follow_up`), `events()` (a generator, closed when done), `wait()`, `WispError`, `SseParser`,
  `decode_frame`, and **`generate_stubs()`** (a `.pyi` with `Literal` overloads of `cmd`).
- Tests: `node --test npm/test/client.test.mjs` (4 pass: commands and refusals, `wait` on the stream, types from the
  catalogue, SSE across chunks and `server.json`); `npm/test/types.test.mjs` (the strict tsc check of
  `fixtures/client-usage.ts`, rewritten for v2: pass); `python3 -I -W error::ResourceWarning
  sdk/python/tests/test_client.py` (3 pass).
- `npm run check`: 0 errors.
- Left: publishing (`wisp` on PyPI isn't claimed; the release workflow doesn't build it yet), a `wisp sdk types`
  CLI verb that writes the generated types, JSON Patch for clients that keep rows from the stream (both SDKs look
  again with `runtime.get` instead).

## 5. The rest (partly)

- **`subagents`** → setting `runtime.subagents` (json, `[]`): the team New task pre-fills. v1 read
  `defaults.subagents` only in the launcher (the server never defaulted it), so it's a declared setting the UI reads;
  a task's own team wins. **For the UI coder:** pre-fill New task's team from it. Coverage → 37 todo.
- **Not done, and why:**
  - `terminalSessions`: needs terminal tasks (the harness's own CLI in a terminal, v1 services/tui.js `openTui`,
    `startsInTerminal`); v2 has the Shell pane's terminal plugin but no task that runs in one.
  - `crew.reply`: needs crew answers stored under the message that asked (v1 `turn.btw` entries with
    `crew/job/thread`); v2's crew never writes `reply`.
  - The plugins install path (ADR-0031): loading a user's plugin from a path, gist or URL into the running kernel
    (fetch, check the manifest and its permissions, start it as an `ExecPlugin`, `spell_installed`/`spell_hook`
    telemetry). It's an architecture change (a new kind of plugin source at runtime) that wants its own ADR read
    of 0003/0031 and the kernel's exec host first.

## Round check

- `cargo clippy` on runtime ×3, budget ×3, accounts ×2, channels ×2, slack, discord ×2, github ×2, email ×2, grid,
  router, wisp (all targets, `-D warnings`): clean.
- `npm run check`: 0 errors. v1-coverage: 37 todo (42 at the start of the round).
- New dependency: `hickory-resolver` 0.26.3 (ADR-0045); `cargo deny check licenses bans`: ok.
- CHANGELOG: four Added lines (channels, Ask near the limit / Wait for the reset, grid mail, the SDKs) and one
  Changed (webhook triggers off until switched on).
