# Backend round 6

## 1. issues.projects and v1 #766

Done in round 4 (docs/v2-backend-4.md) and still on disk: `kinds.rs` `IssueProjects` contributes
`issues.projects@1`; `connectors.call` plus `issues.connectors@1`; Linear/Jira via signed-in connectors.

## 2. Refusals are recorded on turns (v1 runner.js `#refused`, web/js/vendors.js)

- **`Turn.refusal: Option<TurnRefusal { agent, model, vendor?, kind: "policy" | "declined", line? }>`**
  (runtime api, additive; turns persist as JSON so no migration). Bindings: `runtime/Turn.ts`,
  `runtime/TurnRefusal.ts` (new).
- `Effect::Finish` carries the CLI's `stop_reason` (activity.rs; `stop_reason: "refusal"` → `policy`).
- **`runtime/core/src/refused.rs`** (sans-IO): `vendor_of(model, home)` (v1's VENDORS table, bare names
  opus/sonnet/haiku/fable, `o3`/`o4-mini`, `composer`; `""`/`auto`/`default` → the harness's own) and
  `refused(ended, blocks)`: uses the existing `prompt::refusal::refusal_of` (conservative: a turn that changed
  files is never one), and rewrites the hero to **"<Harness> turned this task down"**, status `blocked`, summary
  "Hand the same prompt, with what this task has seen, to another agent, or rephrase it and follow up."; the
  answer's other blocks (minus hero/next) stay under it, else the text as markdown ("No answer.").
- **`Harness::vendor() -> Option<&str>`** (harness point, additive, default None): claude → anthropic,
  codex → openai, grok → xai. The others run anything; their vendor comes from the model id.
- `finish.rs` `end_turn` → `refuse()`: never for a subagent's run (`parent_id`), nor a stopped one.
- Tests: `refused::tests::a_models_vendor_is_read_from_its_id_or_the_harness_default`,
  `refused::tests::a_turn_turned_down_says_so_and_keeps_the_refusal`, lifecycle
  `a_turn_the_model_turned_down_records_who_refused_for_the_hand_off_card` (all pass).
- `cargo clippy -p wisp-runtime -p wisp-runtime-core -p wisp-runtime-api -p wisp-claude -p wisp-codex -p wisp-grok
  --all-targets -- -D warnings`: clean.

### For the UI coder

The hand-off card shows when `turn.refusal` is set: offer the harnesses whose vendor differs from
`refusal.vendor` (when it's unknown, every other harness), with the same prompt and what the task has seen.

## 3a. Drain watch wired (v1 runner.js:1810 `budget.spend`, index.js:145 `onDrain`)

Nothing called `spend`, `drain_of` reached the card only through `budget.view` with no samples, and `drain_why`
had no caller.

- **`turn.ended` carries `account` and `tokens`** (runtime api, additive; input + output, cache aside: harnesses
  count cache differently and Drain watch only compares a harness's runs with its own).
- budget core `drain::units_of(cost, tokens) -> (units, in_usd)` (v1 `unitsOf`: the cost, else tokens in millions).
- **budget host `drain.rs`**: on `turn.ended`, `Budget::spend` (a failed run, not an interrupted one, counts as
  failed), saved; when it shows a drain and Drain watch is on, at most once per window per two hours
  (`DrainNotes`): `budget.drain` (`DrainNoted`, title + text from `drain_title`/`drain_why`, the server's zone via
  jiff, already a workspace dep) and a note through `channels.send` (no phone: logged at debug, nothing else).
- **Setting `budget.drainWatch`** (manifest, bool, off); v1's `defaults.drainWatch: "on"` is imported with the stop
  lines and holds until the switch is set here.
- **`budget.dismissDrain` / `budget.dismissNotice`** registered (declared in the api, never served) + manifest.
- Coverage: `POST /agents/:id/drain/dismiss` → `cmd:budget.dismissDrain`, `POST /agents/:id/windows/dismiss` →
  `cmd:budget.dismissNotice`, `drainWatch` → `setting:budget.drainWatch` (52 todo left).
- Tests: `drain::tests::runs_that_take_twice_their_usual_share_show_a_drain_and_the_phone_hears_once` (core: six
  usual runs, two at 4×, one failed; ratio, runs, failed; note off/once/again after 2 h; dismissed),
  host `drain::tests::drain_watch_is_off_unless_switched_on_here_or_in_v1`,
  `drain::tests::a_runs_work_is_its_cost_else_its_tokens_in_millions` (all pass).
- `cargo clippy -p wisp-budget -p wisp-budget-core -p wisp-runtime -p wisp-runtime-api -p wisp-router --all-targets
  -- -D warnings`: clean. `tools/check` v1-coverage, rust-mcp, rust-manifests: 0 errors.
- For the UI coder: Settings → Usage → Drain watch writes `budget.drainWatch`; the card's × calls
  `budget.dismissDrain {agent, account, window}`; a notice's × `budget.dismissNotice`.

## 3b. leanRuns wired (v1 server/lean.js)

`lean_on` / `lean_task` existed in runtime core; nothing read a setting, and Claude ignored `HarnessRun.quiet`.

- **Setting `runtime.leanRuns`** (manifest enum off | on | all, default on). **`Session.lean`** ('on' | 'off', additive;
  imported from v1's `lean`) and **`runtime.setLean {id, lean?}`** (v1 PATCH `lean`; anything else is refused) +
  manifest; coverage `PATCH /sessions/:id` lists it.
- runtime: a task's turn and its /btw run `quiet` per `lean_task` (the task's choice wins, else Settings' `all`); the
  scout-like side run in more.rs is quiet per `lean_on` (was always). `Host::setting` (seam, default None;
  `CtxHost` reads the kernel's settings; `Recorder.settings` for tests).
- **claude launch:** `quiet` → `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Tests: lifecycle `a_tasks_run_is_lean_when_settings_say_all_or_the_task_asks_and_the_task_wins`, claude
  `launch::tests::a_quiet_run_turns_the_nonessential_traffic_off` (pass). Clippy on runtime ×3 + claude: clean.
  Bindings regenerated (`Session.ts`, `SetLeanArgs.ts`, `TurnEnded.ts`).
- For the UI coder: Settings → Agents → Lean runs writes `runtime.leanRuns`; the task's ⋯ menu "Lean runs: on / off /
  follow Settings" calls `runtime.setLean` (optimistic on `/summary`? `lean` isn't in the summary: patch the session).

## 3c. A routed task reports back to its chat (v1 channels/routed.js `publish`, `#retry`)

- **`grid-client.reply {thread, text} → {status, error}`** (api + host `computer::reply`): `POST
  /api/channels/reply` with the device token (the grid's `edge_route.rs` takes only that). It always answers what
  the grid said (0: unreachable), so the caller decides. Manifest `uiOnly` (wisp.channels' plumbing; an agent has no
  thread to name). Bindings `grid-client/ReplyArgs.ts`, `Replied.ts`.
- **channels:** on `turn.finished` (the turns that notify, as v1's notify pipeline), a task with `remote.routed`
  (`hub::routed_thread`) sends "✓|✗|■ <title>\n\n<preview>" (cut to 4000 chars) through `routed::report`; while
  the grid can't be reached (0, 5xx, 429) it tries again after 15 s, 1 min, 5, 15, 30 min, then drops it with a
  warning; a 4xx is a no and ends it.
- Tests: `routed::tests::a_report_goes_once_tries_again_while_the_grid_is_away_and_stops_when_it_says_no` (pass).
  Clippy on channels, grid-client, grid-client-api: clean.
- Left: v1 queued later reports behind a waiting one per thread (`late`, ≤ 20); here each report retries on its own,
  so two reports during a grid restart may arrive out of order. `remote.routed` is in memory (as all remotes here):
  a restart forgets which tasks were routed.

## 4a. Settings (v1 `defaults.*`) read where they matter

| v1 setting | v2 setting | read by |
| --- | --- | --- |
| `apps` (on unless off) | `runtime.apps` bool, true | `run.rs` `harness_run`: `SystemOpts.apps` (v2 never offered the app block before) |
| `watch` (on unless off) | `runtime.watch` bool, true | `SystemOpts.watch` + `WISP_WATCH=1` (never offered before either) |
| `blocks` ('off': plain markdown) | `runtime.blocks` bool, true | `SystemOpts.blocks`; never plain for a subagent or a crew job (`ext["wisp.crew"]`) |
| `subagentModel` | `runtime.subagentModel` enum '' / haiku / sonnet | `HarnessRun.subagent_model` (Claude's launch already reads it) |
| `followUp` ('queue') | `runtime.followUp` enum interrupt / queue | `follow_up`: a follow-up whose `queue` is unset |
| `windowNotice` (on unless off) | `budget.windowNotice` bool, true | `budget.view` drops the notices when off |
| `drainWatch` | `budget.drainWatch` (3a) | `budget.view` shows the drain card only with it on (v1 meta.js:63) |
| `webhookTriggers` (off unless on) | `automations.webhookTriggers` bool, **false** | `POST /api/triggers/:name` answers the same 404 until it's on |

- Tests: lifecycle `settings_decide_what_a_run_is_offered_and_whether_a_follow_up_queues` (pass; the whole
  lifecycle file, 16, passes: the fake harness now reports `--app`, `--plain`, `--watch`, `--sub=` from its run);
  budget `drain::tests::the_drain_card_needs_drain_watch_and_notices_go_when_switched_off` (pass).
  `crates/wisp/tests/serve_kinds.rs` `a_webhook_trigger_starts_its_task_only_with_its_secret` now switches webhooks
  on first and asserts the 404 before (not run here: it builds the wisp binary; outer loop).
- Clippy on runtime, budget, automations, wisp (all targets): clean. Coverage: 44 todo.
- **Question (kept v1's behaviour):** a webhook trigger declared in wisp.yml stays unreachable until
  `automations.webhookTriggers` is on. v1 gated the route the same way; v2 also needs the trigger's secret, so the
  switch could default on. Kept off until the owner says.

## 4b. Slack on the grammar (v1 channels/slack.js, on a computer)

`wisp-slack-core` was ported (Socket Mode frames and acks, the dial loop, events, markup, posts, the manifest) but
the host was a placeholder. Now `plugins/slack/host`:

- **Transport `slack`** (contributed to `channels.transport`; secrets `botToken`, `appToken`, `signingSecret`):
  `auth.test` → `apps.connections.open` (app token) → the hub's `Ws` → `socket::Listen` (every envelope acked
  first; hello in time; Slack's disconnect) → `socket::Dial` (backoff from `slackBackoffMs`, for-good codes stop
  with "Check the tokens…" in Settings).
- **A message** (`event::message`: an app mention or a DM, no bots, no edits): `link <code>` in a DM links the
  person (code compared whole, constant time; three tries a minute) and saves them in `senders`; then the door
  (`policy::gate`: linked people only, a repeat, too old, too many; a stranger's DM gets one line, a channel
  silence), then wisp.channels' flow (`conv.rs` `SlackConv`: capped at Edits, Plan when none named, answered in
  the thread; `new …` reads as `/new …`; in a channel the status keeps a title's first part). The first reply
  keeps the thread on the task (`remote.slack {channel, ts}`, `mark_started`), so a mention in that thread follows
  up the same task.
- **Reports** (`publish`, a task started here): `post::report` in its thread (title, text, the choices in words,
  how to answer); what leaves is scrubbed, defused, escaped and cut (`slack_text`).
- **`channels.extra {channel: slack, what: manifest}`**: the app manifest (coverage `GET /remote/slack/manifest` →
  `cmd:channels.extra`; 42 todo).
- Tests: `tests::what_leaves_pings_nobody_and_a_link_code_must_match_whole` (pass). `cargo clippy -p wisp-slack
  --all-targets -- -D warnings`: clean.
- Not yet: buttons and clicks (`interactive`; core has `event::click`/`post::buttons`), the cloud box's HTTP
  events (`inbound`, signed), a keep-alive ping (the hub's `WsConn` has none: a laptop that slept keeps a dead
  socket until Slack's own disconnect), one turn at a time per thread, a fake-hub test of the socket loop (no test
  `ChannelHub` exists yet; worth one in channels api for Slack and Discord).

## Round check

- `cargo clippy -p wisp-runtime -p wisp-runtime-core -p wisp-runtime-api -p wisp-budget -p wisp-budget-core
  -p wisp-automations -p wisp-git -p wisp-git-core -p wisp-git-api -p wisp-channels -p wisp-grid-client
  -p wisp-grid-client-api -p wisp-slack -p wisp-claude -p wisp-codex -p wisp-grok -p wisp-router --all-targets --
  -D warnings`: clean.
- `npm run check`: 2 errors, both UI packages (`plugins/issues/ui`, `plugins/learn/ui` registered nowhere: the UI
  coder's). v1-coverage: 0 errors, 42 todo (was 55 at the start of the round).
- Also in 4a: **`git.cloneDir`** (string setting; `git.clone` with no `parent` clones into it, `~/` expanded, else the
  first of v1's usual repo folders that exists, else `~/code`; `CloneRequest.parent` defaults to ''), git core
  `repo_url::clone_root` + test `a_repo_is_cloned_where_settings_say_else_the_first_usual_folder_else_code` (pass).

## Left from item 4 (in the order I'd take them)

1. **Discord** on the grammar (`plugins/discord` is a placeholder: core and host): the gateway over the hub's `Ws`,
   then the same flow as Slack. A test `ChannelHub` in channels api first, so Slack's socket loop gets its test too.
2. **Slack**: buttons and clicks, the box's signed HTTP events, the keep-alive ping (needs `WsConn::ping`).
3. **GitHub comments and email** transports (both placeholders).
4. **Grid mail** + its ADR line for the DNS resolver dependency (not started).
5. **The TS and Python SDKs** (not started).
6. **crew.reply**: needs crew answers stored under a task's message first (v1 `turn.btw` entries with
   `crew/job/thread`); v2's crew never writes `reply`. Feature-sized.
7. **Settings still todo:** `limitHold`, `limitWait`, `liveLimits` (v2 has no limit-card flow yet: nothing detects
   a usage-limit end, and `later.waitAtLimit` has no caller), `terminalSessions` (no terminal tasks in v2),
   `subagents` (v1 meaning unclear: only in client.js).
8. **The plugins install path** (ADR-0031 intent) and `spell_installed` / `spell_hook`: not started.
