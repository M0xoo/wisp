# v2 build queue (code first, verify later)

**Fix first: #756 CI on 13809a94 (2026-11-13).** fmt, clippy, the Rust suite and tools tests all pass. The monoflow
run over every package fails 3 of 191 targets, all load-sensitive (each passes in the plain test step):
plugins/shell-list/ui/test/flat.test.ts:26 (compare card) and plugins/shell-task/ui/test/file-view.test.ts:27 (go to
definition) time out at 5 s; crates/wisp-proc tests/bench.rs fails (output truncated in the report). Find why each is
slow under parallel load (real slowness is a bug; a fixed wait is a flaky test) and fix the cause; a bench that asserts
timings must not run in the test step (an ignored test or a spike).

**Fix first: #756 CI on c3278499 (2026-11-13).** `plugins/history/host/src/tests.rs:201`
`notes_keep_the_tree_clean`: `history.track` fails with "git notes couldn't keep history/<id>.jsonl.zst" on Linux CI
(both Node versions). Likely git notes needs a committer identity CI's git lacks (no user.name/email), or a recent
change (GIT_OPTIONAL_LOCKS, the temp-index work) broke the notes write. Reproduce with an empty HOME/GIT_CONFIG_GLOBAL;
wisp must keep notes in a repo whose user has no identity set (give the notes commit wisp's own identity as v1 did,
never touch the user's config). Show git's stderr in that error.

**Fix first: #756 CI on 1e58037b (2026-11-13).** `plugins/claude/core/tests/g6.rs:105` and `:181` (G6 33/34):
`compact-real` result event #9 now has `stats.contextWindow` (added by the #785 port), the v1 recording doesn't. Check
what v1 #785 (`git show fd4d280a`) emits: if v1 now has a context window too, refresh the recording the way G6's
fixtures were made; if it's a v2-only additive field, make G6 compare v1's fields and list the additive ones by name
(not a blanket ignore). G6 back to 34/34.

**Bug (found 2026-11-13, round 64):** `plugins/channels/host` `KPhone::projects` reads `/projects` from the
`resources.export` answer, but that command returns `Vec<Resource>` (an array), so a channel's context never gets the
projects or the default project. Fix with a test that a channel task lands in the right project.

**Fix first: #756 CI on 4dfb2791 (2026-11-13).** `crates/wisp/tests/serve_code.rs:33`
`a_formula_applied_exported_and_its_workflow_run` (node 24): the test's `git commit -qam` still hits `.git/index.lock:
File exists` after GIT_OPTIONAL_LOCKS=0. Some git call wisp makes during a formula's workflow run *writes* the index
(add, stash, worktree, checkout, a refresh that isn't read-only). Find which (trace git argv in that test), and either
make it not touch the user's index while a task runs, or make the test wait for wisp's operation to finish (an event or
the run's state, never a sleep). Real users commit while wisp works: a wisp write must never fail their commit.

**Fix first: #756 CI on 0ff243fa (2026-11-13).** Only failure, both Node versions:
`plugins/channels/core/src/ws.rs:266` `ws::tests::fragments_join_and_control_frames_come_through`: the parser yields
`[Ping, Text("hello"), Pong, Close(1000,"bye")]`, the test wants no `Pong`. Decide by RFC 6455 and the callers (Slack
socket mode, Discord gateway): if a Pong is a frame the caller never needs (keep-alive is answered by the transport),
the parser drops it; if a caller uses pongs (latency, liveness), the test is wrong. Fix the root cause, run `cargo test
-p wisp-channels-core ws`.

**Fix first: #756 CI on 10ec0372 (2026-11-13).** Linux only: `plugins/accounts/host/src/signin.rs:298`
`a_login_that_asks_on_a_terminal_gets_one_on_linux`: argv_of gives `script … /dev/null` with the command at another
index than the test reads (left `("script", "/dev/null")`). Check util-linux `script` usage (`script -qec "<cmd>"
/dev/null`), make argv_of and the test agree on what really runs a login on a Linux tty, and run it on Linux semantics
(the test only asserts on linux, so it never ran on the Mac).

**Next one-concern items (2026-11-13):** (1) the answer `code` block has no CSS in v2 (unstyled; v1's `.blk-code`
values, highlighting, copy button); (2) Claude Code's own subagents per turn in TurnStats so the usage card lists them
by type (#785 leftover); (3) re-take the task.more and task.right-click v1 references after #786.

**Fix first: #756 CI on 0b5bff88 (2026-11-12).** tauri and tauri windows green on every OS (DESK2-01, DESK2-05 fixed).
`pr` fails 3 tests in one file (`a_changed_harness_holds_its_turn_until_trusted`,
`a_second_codex_account_signs_in_and_its_runs_use_its_folder`, `keys_limits_and_the_v1_routes`) at
`crates/wisp/tests/common/mod.rs:65`: "…/build/wisp/<hash>/out/wisp-fake-agent after the build": the helper builds
`wisp-fake-agent` into the target dir but expects it at the build script's OUT_DIR. One home for the fake binary, the
same locally and in CI.

**Fix first: #756 CI on 9912daf5 (2026-11-12).** DESK2-01 passes now. Left:
1. **wisp's git reads race the user's commits (real bug, flaky test).** `serve_code.rs:33` on node 22: the test's
   `git commit -qam` failed with `.git/index.lock: File exists` because wisp ran git in the same repo at that moment.
   Every read-only git call wisp makes (status, diff, watcher refresh) must run with `GIT_OPTIONAL_LOCKS=0` (v1 did) so
   it never takes index.lock; a named test that commits while wisp refreshes in a loop.
2. **Flaky serve_kinds** on node 24 (node 22 passed the same code): `a_webhook_trigger_starts_its_task_only_with_its_secret`
   (serve_kinds.rs:315 unwrap on None), `a_pipeline_moves_on_at_a_limit_and_picks_the_best_of_n` (common/mod.rs:159 wait
   timed out), `a_trigger_and_a_pipeline_start_tasks_and_an_app_lands_on_the_shelf`. Find the race (a read before the
   write it waits for, a fixed sleep, a shared fake); fix it, never retry.
3. **DESK2-05 on Windows: "the shell never quit".** The Job Object fix is in, but the app doesn't quit on the QA's Quit
   on Windows. Make the QA quit the way a user does on Windows (close the window: v1 quits there) and make sure that
   path exits the process.

**Round 39 (done):** Run on another computer as v1 (find or clone the repo there, join its projects, same subfolder;
a second computer in the mock); 11 rows: answer pictures load, viewer, Copy, Show in folder, kept shots; 👍/👎 and
Send feedback; un-archive on reply; Compare runs keep their title; /btw; no team cap; wisp blocks switch. Next: partial
(104) and missing (17) rows, most-used first (F-page-41 `.env` Reveal, F-auto-5 times in the reply box, F-task-27 a
second folder).

**Round 38 (done):** 13 rows: queue and held queue, start-later from New task, paste-a-task mention, Rerun… dialog
(and its broken path), kept place, Run on, thinking slider, topic search. Next: partial (113) and missing (18) rows,
most-used first.

**Round 37 (done):** window close checked against v1 (unchanged on macOS; quit elsewhere, as v1), F-task-32 drafts,
F-task-38 and F-task-4 verified with tests. Next: a queued follow-up in the mock for F-comp-24, then partial (126) and
missing (18) rows, most-used first.

**Round 36 (done):** serve_grid's Box credential (401 forged / 403 verified, tests agree with ADR-0014), DESK2-05 on
Windows (close quits; Job Object; QA names the side: CI to confirm), the first-run launcher at 390. Next: partial (129)
and missing (18) rows, most-used first.

**Done in round 36: #756 CI on 03aeb5f8 (2026-11-12).** (1) `crates/wisp/tests/serve_grid.rs:307`
`a_computer_and_a_box_through_the_grid`: a box's credential (`authorization: Box ada x`) sent to a computer's host now
gets 401, the test wants 403 (a_box_never_gets_a_laptop_token). Decide which is right (a known box credential at the
wrong place = 403; a malformed one = 401?) and make code and test agree with the ADR; first run of the pr suite since
clippy was fixed, so this may be older than round 33. (2) DESK2-05 passes on macOS now but still fails on Windows
(smoke, desktop, migrate): Quit on Windows doesn't stop `wisp serve` (no SIGTERM there: the stdin pipe or a Job Object
must end it; check the shell closes the pipe on Quit, and that the server's stdin reader sees EOF on Windows).

**Round 35 (done):** DESK2-01 (installer pre-install hook clears v1's Node and app; QA checks leftovers and ~/.wisp: CI to
confirm), the mock's harnesses and first-run seed, F-page-11, the compare card, F-task-20. Next: partial (129) and missing
(18) rows, most-used first.

**Done in round 35: #756 CI on d4ad3fe1 (2026-11-12).** `tauri windows` migrate: **DESK2-01** "setup.exe /S installs the app: a
bundled Node is still there: v1 packaging". Installing v2 over a v1 install must remove v1's bundled Node and its
other leftovers (the installer's upgrade step, NSIS), keeping the user's data in ~/.wisp. (DESK2-05 and hardKill were
fixed in round 33; clippy items_after_test_module in term.rs too.)

**Round 34 (done):** the trigger form's runner picker, vs in New task and Compare's Plan row (wisp.budget now traces
shares to turns), Watch opening by itself; v1-features F-task-36, F-comp-4, F-task-31, F-comp-35 built, F-page-35/23
corrected. Next: F-page-11 (unsent comments to Ship), the feed folding a compare into one task, then the remaining
partial (130) and missing (19) rows, most-used first.

**Round 33 (done):** DESK2-05 (Quit hung on a kernel lock-order deadlock: fixed, test) and `hardKill`'s "not found";
v1's trigger form to parity; Compare runs (F-comp-30) and Watch (F-page-32) with their menu entries. Next: the
launcher's vs toggle and Plan row for Compare; Watch's tab opening by itself; the Harness runner picker in the trigger
form; docs/v1-features.md partial and missing rows (132 partial, 23 missing), most-used first.

**Done in round 32: #756 CI on cee52d53 (2026-11-12)** (boot no longer waits on a harness: docs/v2-round-7.md Round 32). `crates/wisp/tests/serve_cli.rs` `ctrl_c_detaches_and_a_second_ctrl_c_stops`
fails: "wisp serve never advertised its port" with an empty serve.log. It passed on 497ec9cb; between the two, Rust
only changed `crates/wisp/src/serve.rs` (`stdin_closed`/`WISP_EXIT_WITH_STDIN`). Repro on the lead's Mac:
`WISP_HOME=/tmp/x FAKE_HANG=1 wisp serve --port 0` never writes server.json and logs nothing, the same without
`FAKE_HANG` starts in under a second. Find why boot depends on that env (a harness probe at start that waits on a
hanging CLI would also break the cold-start budget: boot must never wait on a harness). Root cause + the test.
Then, from 5168dd55's run: `qa/desktop-v2.mjs` passes DESK2-02/03/04 on macOS but **DESK2-05 fails** (Quit doesn't
stop the server: "waited 15 s for the server to stop"; Windows smoke too): Quit must stop `wisp serve` and close the
port within the shutdown budget (find what keeps it alive: a plugin's scope, a child, the stdin reader). On Windows
desktop/migrate, `hardKill` (desktop-v2.mjs:99) throws when `taskkill /F` finds the process already gone: treat
"not found" as done. Earlier note: the `tauri` linux-qa and `tauri windows` desktop/migrate/web jobs failed on cee52d53 too (v1 QA scripts): check they
pass with round 30's qa/desktop-v2.mjs on the next run.

**Done in round 29: #756 CI red on f45efe67 (2026-11-12)** (see docs/v2-round-7.md Round 29).
1. `crates/wisp/tests/serve_budget.rs:34` `unattended_work_past_the_stop_line_is_held_until_the_window_resets`: the
   user's own codex run at 90 % now comes back `error` with "past your 90% line … confirmLimit" (the usage-limit flow,
   Settings → Usage → Ask near the limit). Decide by v1: if v1 asks before the user's own run past the ask line, the
   test sends `confirmLimit: true` for "mine"; if v1 doesn't ask at that point (the ask line default / off), the flow
   is wrong. Fix the root cause, not the assert.
2. `tauri windows` build: `desktop/scripts/package.mjs:42` reads `pkg.files`, which v2's root package.json dropped
   (TypeError reading 'map'). macOS `tauri` passes. Make the Windows desktop build package the v2 binary the way the
   macOS one does (no `files` dependency), so both use one v2 path.

**Round 32 (done):** #756 boot fix (router's start no longer probes harnesses); ⌘K Recipes/Triggers; Merge/Review
PR in the menus. Next: the Compare runs view (F-comp-30) and the Watch pane (F-page-32), v1's trigger form, then
v1-features rows.

**Round 31 (done):** Pin/Mark read after v1's entries (allowed.md §5); Run app / Stop app as v1 (the run mark on the
row); the task's More in v1's order (runtime.resumeCommand); the four references re-captured without launcher.tryTwo.
Next: automations.trigger-new's v2 opener, me-menu's missing parts, More's Compare/Merge/Review/Watch entries, then
v1-features rows.

**Round 30 (done):** v1's row menu (12 entries through `shell.row:menu`, crew.adopt), the kit ProjectsSheet (parity 0
in the dialog), desktop QA on v2 on every OS (qa/desktop-v2.mjs in tauri, tauri-windows, tauri-package). Next: the open
task's More as v1 (Rename, Copy task ID, Copy resume command, Open project in editor, Save for later, Restore to before
latest turn, sized to fit), a re-captured v1 reference without `launcher.tryTwo`, then v1-features rows.

**Round 29 (done):** #756 (serve_budget by v1's numbers; the desktop app runs the v2 binary on every OS); Auto's
popover; the issue picker as v1's palette; right-click selects its row; one pane frame per app across tasks. Next:
the row menu's v1 entries (Rerun, Fork, … through the contract), a kit ProjectsSheet (v1's Projects layout and phone
modal), the Windows desktop QA scripts on v2, then v1-features partial and missing rows, most-used first.

**Round 28 (done):** the pane correction (saved defaults, v1's card exactly); the launcher focus border; Preview's
element picker (ADR-0049, the run proxy); the crew rail's hover card; panes beside tasks (`SideTabDef`); v1-features
partial 143 → 140. Next: v1-features partial rows, most-used first; for the lead: home.auto-preview (v1's Auto
pick-preview popover is missing in v2), the issues picker's layout (v1 a top palette 640 wide), projects/right-click
layout; one pane frame per app across tasks (v2 reloads it on a task switch).

**Round 27 (done):** the owner's four decisions; phone Crew job cards (ShellApi `taskCards`); panes on Home with the
bridge host; Org drag and link; folder suggestions (`runtime.folders`, kit `PathField`). Next: Preview's element picker
(a proxy that injects the pick script: Rust), panes beside tasks, the rail's hover card (then side by side can leave
delegated jobs out too), the `launcher#0` focus-state difference across home/task views, then v1-features partial rows.

**Lead's parity pass after round 23 (2026-11-12, `/tmp/qa-lead/parity`, 1440+390 browser):** the kit-wide CSS
changes broke no metrics (home, palette, task, task.composer: 0 parts off at 1440). Left: (1) crew and task.transcript
are not reachable at 390 (the opener's click times out: the phone layout hides what it clicks); (2) pixels fail on
regions over 8×8 though under 0.5 % (home 19, palette 37, task 17): find what differs (icons, antialiasing, a shade)
and fix it or record it in allowed.md with the reason; (3) settings.agents at 390: opencode's Add key sits over the
version line and "2 models" wraps; Antigravity/Grok "Signed in · Sign out" crowds the row (design/layout.md: nothing wraps).

**Left after round 18 (2026-11-11), in this order:** (terminal tasks and Discord's `/wisp`, buttons and grid-held
interactions: done in round 18) the grid checking Discord's signature itself, so a stranger's `/wisp` wakes no box;
a terminal task on Codex and the others (only Claude's `resume_command` names a conversation); ADR-0048's
descriptor UI (a Worker in a sandboxed frame; the shell renders kit descriptors; calls as the plugin) and then the
WASM host; sandboxes' Browser tab (box image + previews of a box's ports on the edge) and the task head's Sandbox pill;
Run on in the GUI (machines are peers of the app now); hover from a language server in the file view.

**Done in round 18:** sandboxes (ADR-0047: /sandbox, delegates, crew jobs, judges, the pane, sign-ins, env, owners and
the sweep), the app's peers through this wisp, the file view's ✦ and Go to definition, New task's @ files, the
untrusted tier's trust and clean environment (ADR-0048).

**Done in round 17:** projects reach the app (published on `config`), one project filter, #772, the Projects dialog,
the Plugins pane, the file view and the why-gutter, email attachments, Discord REST buckets.

**Done in round 16:** terminal.apps (below), the plugins install path (ADR-0046), crew.reply, one turn per Slack thread,
a PR following its branch's task, the serve_budget e2e, `wisp sdk types`.

**Bug seen in round 14's PNG (2026-11-11):** a toast says "unknown command terminal.apps (is its plugin off?)" on Settings
open. `terminal.apps` is listed (ui-only) but no server handles it at runtime. Serve it (list the terminal apps
installed on this computer). The ui-commands rule should have caught this, so check why it didn't (does a ui-only listing
skip the host check?), and make the rule catch it.

**Sandboxed execution, the gaps (owner asked, 2026-11-11):**
- **Sandboxes, the whole v1 feature plus judges (owner, 2026-11-11):** v1's design is `design/sandboxes.md` on
  origin/main; port its rules.
  - **Subscriptions:** sandboxes run on the user's own subscription. Sign in once for all sandboxes (Settings →
    Cloud → Sandboxes: `claude setup-token` on a pty, the token sealed on the grid per user, given to every
    sandbox as `CLAUDE_CODE_OAUTH_TOKEN`, never to the user's own box, never kept on the laptop). Never copy a login
    file. Codex and the other harnesses: their device login inside the sandbox (v1's open item: do it in v2), and
    the API keys for opencode and the others.
  - **Run as:**
    - **the main prompt:** `/sandbox` in New task, so the project goes along as a git bundle (uncommitted changes
      included) and `.wisp/sandbox.sh` runs once;
    - **a delegate:** Sandbox as a delegate's place (`machine: "sandbox"`, the lead's work bundled, deleted with the
      lead);
    - **a crew member's jobs:** "Their jobs run on" → a sandbox per job, or one of their own;
    - **goal judges (new in v2):** a sandboxed task's judges run in its sandbox, and a goal can ask for judges in a
      sandbox.
  - **v1's rules:**
    - a sandbox has one owner (a task, delegate, member or job) and is never a place you pick in Run on or
      Machines;
    - it shows in the machine pill's slot as Sandbox;
    - deleting the owner deletes it;
    - root inside under gVisor;
    - the Browser tab drives its real browser;
    - Env vars on the Sandboxes card;
    - the grid's per-user cap, and "grid full" fails at once.
  - Done when v1-features F-page-36 and F-mach-17, plus a new row for judges, are built with named tests and seen in
    Chrome.
- **The untrusted plugin tier (plan §6.0.2):**
  - a user plugin's UI runs in a sandboxed iframe or worker with no DOM, sending kit component descriptors that the
    host renders (the Figma split, remote UI), over the same plugin API by RPC;
  - its server code stays a JSON-RPC subprocess;
  - then the WASM component host (wasmtime, WASI 0.3, behind the `wasm` feature) as the sandboxed third-party tier.
  - ADR first: it extends ADR-0046, and the default for anything downloaded is the untrusted tier.

**Project selector + switcher (owner, 2026-11-12): done** (10d8f30f). It replaces v1's chip row on the owner's decision.
- Record it in design/v1-reference/allowed.md (topbar.projects) and docs/v1-features.md, so parity doesn't flag it.
- Backend: `wisp add .` stores the path as "/repo/." (the UI now normalises it). Canonicalise it in the CLI and in
  runtime's project kind on apply, with a named test. **Done (round 21):** `wisp_runtime_api::paths::canonical_project_path`
  (trailing `/.` and `/`, `.`/`..`, relative against the CLI's folder, `\\?\` and `\\?\UNC\` stripped, URLs kept); the CLI sends it
  canonical and the project kind tidies every spec on apply (`StoredKind::tidied`, additive). Tests runtime-api
  tests/paths.rs (2), `a_project_applied_with_a_trailing_dot_or_verbatim_prefix_is_stored_canonical`.

**List row parity (owner, 2026-11-12): done** (81f8eb96): v1's row with one dot, logo and name, the pill on the preview line, floating quick actions. Run `qa/parity.mjs --views=home` once the home reference shows rows.

**v1 sync 2026-11-12 (port these first in the next job):**
- #775: a goal is checked only after its agent is done;
- #776: an image loading doesn't move the page;
- #777: no Allow & retry on a Full auto turn;
- #779 and #780: an opened step shows its full title;
- #781: Stop asks first;
- #778 waits for the phone frontend.

The details are in docs/v1-sync.md.

**One coder from here (2026-11-11). backend-coder's leftovers join the queue, after the UI items:**
- From backend round 7:
  - the plugins install path (an ADR first: a plugin source at runtime, through the kernel's exec host, per
    ADR-0003/0031);
  - crew.reply (store crew answers under the message that asked);
  - terminal tasks, for terminalSessions;
  - Discord's /wisp slash command, buttons and box interactions, plus REST rate-limit buckets;
  - one turn at a time per Slack thread;
  - a PR following its branch's task (GitHub);
  - email attachments;
  - the serve_budget e2e for Ask near the limit;
  - a `wisp sdk types` CLI verb.
- UI notes from round 7:
  - [x] the limit card (`turn.limit`: who, until when, other accounts, the extra-usage way), plus Settings → Usage's
    Ask near the limit, Wait for the reset and Live limits (rounds 14–15);
  - [x] New task pre-fills its team from `runtime.subagents` (round 15).
- Found in round 15: automations' own sources (`schedule`, `once`, `webhook`, `manual`) declare an empty field
  schema, so the trigger editor shows no `cron`/`at` field for them; declare their JSON Schemas in the source.
- Owner action: claim `wisp` on PyPI before the Python SDK goes into the release workflow.

**Fix first when the usage limit resets (2026-11-11, `npm run check` = 21 errors; the check hung on a rust-sizes
loop that hid them, now fixed):**
- UI coder:
  - `packages/ui/src/css/answer-content.css`: 76px is off the token scale (:67, :73), and flex-wrap is outside Wrap
    (:79, :83);
  - `app-task.css:108`: flex-wrap;
  - `composites.css:38`: a selector ending in an :is() list;
  - `connectors/ui/src/panes/Connectors.tsx:72`: location outside navigate();
  - `stuff/ui/src/StuffPage.tsx:82`: fetch outside @wisp/client;
  - learn-ui and issues-ui are unregistered (build them once the backend lands).
- backend-coder:
  - `connectors/host`: 8 commands are listed but registered nowhere (rust-mcp). Register them through the kernel,
    so they're in the catalogue and MCP tools;
  - learn and worktrees keep tables but register no resource kind (add one, or list it in
    plugins/resources/pending).
- Both:
  - the WIP commits stopped at the usage limit: "wip(v2 gui): task page PR and Shell panes…" and "wip(v2 issues)…";
  - the coder was mid-edit on TaskView's turn folds and `shell.turn:foot`, and the edit was refused. Redo it.

**One coder again after the 2026-11-11 round (owner: token burn).** Earlier: **Two coders (owner, 2026-11-10).**
- `coder` owns the UI: ui-commands → 0, then the UI burndown with the gates and the v1-features rows that need screens.
- `backend-coder` owns the v1 sync ports, the v1-coverage check and its backend gaps, the channels grammar and
  transports, and the SDKs.
- They use separate CARGO_TARGET_DIRs (/tmp/wisp-target-coder and /tmp/wisp-target-b). The lead commits.

The coder takes the next unchecked item as soon as one ends, with no wait for review or CI. Rules are in
`docs/v2-team-brief.md`: stay compiling (`cargo check`), clippy on the touched crates, write the ADR's named tests,
no local full suites. The lead commits each item by concern and pushes; PR #756 CI runs the tests. CI failures
are fixed at the start of the next item.

**[x] Done 2026-11-10 (docs/v2-round-7.md, round 5).** **v1 → v2 coverage sweep (owner, 2026-11-10: "the backend isn't finished, a lot of searching for missing work").**
Right after ui-commands reaches 0, and before the UI burndown:
- A `tools/check` rule, `v1-coverage`, maps every v1 HTTP route (`docs/v1-routes.txt`, 304, generated from v1
  `server/routes/*.js` on origin/main), every v1 MCP tool, CLI command, setting key and telemetry event to the v2
  command, setting or event that serves its intent.
- An unmapped item is an error, unless `docs/v1-dropped.md` lists it with a reason (ADR-0031: no compat routes,
  but the feature's intent is kept).
- The generated table goes in `docs/v2-coverage.md`, and each unmapped item is work: build it with a named test.
- Quick counts already show holes:
  - connectors: 9 v1 routes, 0 v2 commands;
  - spells/plugins: 10 vs 2;
  - issues/projects: 11 vs 1;
  - learn: 0 commands.
- Known gaps to fold in:
  - the channels grammar (Slack, Discord, GitHub, email);
  - the machine process view, stop/fix/clean and the heavy-step lock;
  - update relaunch, `wisp ssh`, the copilot reader;
  - the missing telemetry events;
  - grid inbox, mail, routes and sites;
  - the TS and Python SDKs;
  - the `harness == "claude"` branch in `runtime/setup.rs`;
  - regenerating the TS bindings.

**For the UI coder, from backend-coder round 6 (2026-11-11):**
- **The refusal hand-off card** shows when `turn.refusal` is set. Offer the harnesses whose vendor differs from
  `refusal.vendor` (when it's unknown, every other harness), with the same prompt and what the task has seen.
- **Settings → Usage:** the Drain watch switch (`budget.drainWatch`). The drain card's × calls `budget.dismissDrain
  {agent, account, window}`, and a notice's × calls `budget.dismissNotice`.
- **Settings → Agents:** Lean runs (`runtime.leanRuns`). The task's ⋯ menu gets "Lean runs: on / off / follow
  Settings" (`runtime.setLean`).

**For the UI coder, from backend-coder round 5 (2026-11-11):**
- My Stuff's Publish shows `published.url` (open, copy) and Unpublish, and `stuff.targets` names the grid.
- Settings → Phone gets "Accept tasks from channels" (`channels.acceptChannels`).
- The grid account page gets the routing form: bot token and the people who may route.

**For backend-coder, from the UI coder (round 14, 2026-11-11):**
- **settings never read back on a real server:** the peer publishes `settings_value` rows (`{id, body: {v}}`,
  `crates/wisp/src/settings_store.rs`) but every UI reads `setting` rows (`{key, value, locked_by}`: the client's
  `settings.ts` patch, each plugin's `fromRow`, the dev seed). A write is stored (`wisp settings get` says true) and
  the pane shows the default after a reload. Publish `setting` rows (or say which name wins and the UI follows);
- `router.preview` answers in ~7.5 s (the same as `runtime.agents`), so Auto's pick shows long after you stop typing;
- `terminal.apps` is unknown on the edge (Settings → General's Take over in toasts it on every open);
- the grid's signed-in pages: v2 serves no `/account` (nothing calls `pages::account_page`), so the routing form
  (`route_section`, already rendered there) and its `POST /channels/route` and `/channels/route/remove` (v1
  server.js 842–861: CSRF, a rate limit, the flash) have nowhere to live;
- `RunPick` has no account, so the limit card can't offer "Continue on <other account>";
- a crew member's `bg` (v1 #768: the task panel tint, '' their glow, 'none', or a crew colour), for the editor's
  Task panel row.

**For backend-coder, from the UI coder (round 13, 2026-11-11):**
- a per-day usage command, for Usage → Charts and breakdowns and the Crew track record (v1's usage page);
- a file-index command, for the @ menu's files (v1 lists a project's files for @).

**For backend-coder, from the UI coder (2026-11-11):** record refusals on turns, so the refusal hand-off card shows
(v1: a Claude refusal is offered to another harness).

**For the UI coder, from backend-coder (2026-11-10):**
- **Settings → Learning** (v1's pane): the lists by scope with edit and remove (`learn.set`), the recent retros
  (`learn.view` history), and the on/off switch (`learn.enabled`).
- **The launcher:** send `autoOverride: {key, type}` when you pick a harness after Auto's preview showed another.
- **The task card:** show why Auto picked it (`ext["wisp.router"].route`: `why`, `chance`, `usd`).
- **The reply box:** the cold-cache line and the Compact now button (`runtime.cold`), and the Fable vendor mark.
- **Issues:** once backend-coder lands `issues.projects` and #766, build the Issue picker and the "Connect Linear… /
  Jira…" prefilled connector form.

**For backend-coder, from the UI coder (2026-11-10), blocking two screens:**
- learn: its host is a placeholder. Port v1's memory and retros with their commands, for Settings → Memory.
- issues: `issues.list` can't resolve a project, because nothing contributes `issues.projects`. Contribute it from
  runtime's projects, for the launcher's Issue picker.

**v1 sync (owner, 2026-11-10: "check changes to v1 every so often").** v1 fixes the owner lands on main get
ported here. The log and the per-commit actions are in `docs/v1-sync.md`. Open from the first sync: #760 (a quiet
crew job keeps its follow-ups), #761 (desktop new-tab links), the #763 rest (probation, vendor id, pricing), #764
(launcher pick for a crew job). Do them at the start of the next job, each with its named test.

**v1 inventory done (2026-11-10): `docs/v1-features.md` (326 features with tester scenarios),
`docs/v1-features-summary.md`.** 102 built, 181 partial, 39 missing, 4 dropped (ADR-0031).
- Decision: a feature is **built** only when every frontend v1 offered it in has it (GUI included). Server plus CLI
  without the GUI stays **partial**.
- The work it gives, in order, after ui-commands reaches 0:
  1. mount the 13 unmounted plugin UIs plus shell-home's tips and notifications;
  2. build the 8 shell-task stubs (TaskHead, Transcript, PlanView, AskCard, HaltCard, HeldCard, Receipt, WhatChanged);
  3. v1's ~30 keyboard shortcuts;
  4. the summary's top 30, in order;
  5. every remaining partial or missing row.
- Each row turns `built` with its evidence (the command, the screen and a named test, run through the gates on its view).
- The `v1-features` check (rule over docs/v1-features.md) comes with item 1. Verify the 13 'not verified' rows with
  named tests.

**Nothing of v1 gets lost (owner, 2026-11-10: "v1 UI and features are amazing, make sure we don't lose any of
them").** Part of the coverage sweep. Its scope is user-facing features, not only routes:
- **Generate `docs/v1-features.md`** from v1 on origin/main:
  - every CHANGELOG entry under Added and Changed (632 user-facing entries over 72 releases), one row each;
  - every `web/js/features/*` module (99), each Settings pane and setting key, each keyboard shortcut, each
    tip, each menu item, each answer block type, each CLI command.
- **Each row gets its v2 status:** `built` (the v2 command, screen and named test that carry it), `missing`
  (work), or `dropped` (with the ADR or the owner's words). A v1 bug fixed in v2 links `docs/v1-bugs-fixed.md`.
- **A `tools/check` rule, `v1-features`:** a row without a status is an error, and `missing` rows are counted in
  CI's summary. They're built one by one, UI included, through the gates.
- **The default is to keep it.** Anything unsure is kept as v1 had it and asked about under *Questions* in
  `docs/v1-bugs-fixed.md`. Only the owner or an ADR drops a v1 feature.

**GUI naming (2026-11-10):** the task side menu still says "Take over". The decision is "Open in <harness>" (for example "Open
in Claude Code"; CLI `wisp open <id> --in X`, TUI `o`). Rename it in every frontend and in the i18n keys.

**[x] Done 2026-11-10 (docs/v2-round-6.md, round 4).** **TUI colour fix (owner's real Terminal, 2026-11-09):** Apple's Terminal.app (`TERM_PROGRAM=Apple_Terminal`) doesn't draw
24-bit colour; it shows it as grey. The owner's shell sets `COLORTERM=truecolor`, so `plugins/tui/api/src/theme.rs`
`from_env` picked true colour and the whole TUI came out washed grey. With `COLORTERM=` it's right.
- Fix: `TERM_PROGRAM=Apple_Terminal` always gets the 256-colour theme, whatever `COLORTERM` says.
- Add `WISP_TUI_COLOR=truecolor|256|16` to override.
- Named test: `apple_terminal_gets_256_colours_even_with_colorterm_truecolor`.

**[x] Done 2026-11-10 (docs/v2-round-6.md, round 3).** **Next coder job, small (owner, 2026-11-09): Fable in the Claude model catalogue.** Claude Code 2.1.321 accepts
`--model fable` (Fable 5.2, `claude-fable-5-2`, the newest and most capable).
- Add `model("fable", "Fable", "Newest and most capable")` to `plugins/claude/host/src/lib.rs`, first after Default.
- Add `"fable" => "Fable"` to `plugins/budget/core/src/compare.rs`.
- Check that the router plugin's model ranking, families and blocked/prefer rules accept `claude:fable`.
- Named tests: `claude_catalogue_lists_fable`, `router_ranks_claude_fable`, `budget_labels_fable`.
- v1 gets the same fix in a separate PR from Sana (delegation 80eea720eab0): match its label and hint.

**Fix first (from PR #756 CI, run 42673407031):** `crates/wisp/tests/serve_code.rs`
`a_formula_applied_exported_and_its_workflow_run` (:109) and `atomic_apply_every_kind_history_import_and_sharing`
(:246) fail. `wisp apply` says "no plugin in this wisp owns `tasks:`", so a recent round dropped the owner of
the `tasks` section (the runtime's task-spec kind). Find which round, restore it at the root, and run those two tests
alone.

1. [x] **Events + triggers** (ADR-0044, then ADR-0043), plus the setup probe's "timed out" message (running).
2. [x] **Grid leftovers** (all but `wisp ssh`, see docs/v2-round-2.md) (ADR-0041 / v2-grid-round.md "Not built"):
   - GitHub and Google sign-in on the grid;
   - the boxd container driver;
   - sandboxes as peers;
   - `wisp ssh` through a grid ssh gateway;
   - teams in the CLI.
3. [x] **Terminal context** (ADR-0023): `wisp.termctx` plus the `termctx.source@1` sources (tmux, WezTerm, kitty, iTerm2, scrollback), and the `terminal.failed` trigger source.
4. [x] **Rest of the backend:** (all but the transports past Telegram, which wait on the channels grammar, and the machine process view: see docs/v2-round-4.md)
   - the telegram, slack, discord, github and email transports, with the WebSocket client;
   - the computer pane (`wisp.machine`): sampling, guard, heavy-step lock;
   - the update host;
   - telemetry emitted from the owning plugins;
   - the 3 settings into the registry;
   - task and My Stuff mentions in prompts;
   - setup "changed since" and harness versions;
   - the uiOnly rule into tools/check;
   - the copilot session reader.
5. [x] **GitHub Action and image, git hook** (ADR-0040).
6. [ ] **TUI** (first slice done in round 6: list, answer, composer) (ADR-0024): `wisp tui` mirrors the GUI with ratatui, from the Rust SyncClient; `tui.view`, `tui.input` and `term.block`; `--on <machine>`.
   - **The bar is `docs/v2-tui-design.md` (owner, 2026-11-09): opencode / Claude Code conversation, lazygit / k9s
     navigation, in wisp's look.** The first slice is round 6; the rest of that doc is this item.
   - Built (docs/v2-round-6.md, "Item 6"): the points, the shell, the views, the goldens. Left: `--on`, For later and
     Repo tab, the blame gutter, hunk jumps, terminal images, the real-terminal pass.
7. [ ] **GUI** (ADR-0016/0017/0012):
   - **See what you build:** Claude in Chrome (or playwright-core in /tmp) on every UI change; see docs/v2-team-brief.md "Seeing the UI you build".
   - **UI quality plan (owner, 2026-11-10: "too many bugs to even count").** The gates make the bug list, not people.
     1. **References first:** capture v1's desktop-mode reference for every view in `design/v1-reference/` (46 of
        49 have none for desktop, so they're unchecked). Use the same capture tool v1-reference used, on v1 in
        desktop mode, with the seed data.
     2. **Baseline (2026-11-10):** parity 0/96. home isn't reachable; task has 109/153 parts off and 6.9 % px.
        Record the per-view table in `docs/v2-ui-burndown.md` after every round.
     3. **Burn it down one view at a time:** for the view you touch, run `node qa/parity.mjs --views=<view>`,
        `qa/layout.mjs --views=<view>` and `qa/feedback.mjs --views=<view>` (the hook allows one or two views).
        A view is done when all three pass at every width and theme and every button reaches the server
        (ui-commands at 0).
     4. Order: home → task (+ composer, changes, goal, more, ship, transcript) → list/palette/me-menu → settings
        panes → crew → stuff → automations → projects, then the new screens.
   - the 46 remaining views at v1 parity;
   - the new screens: Repo tab, blame gutter, import, Share setup, Setup section, My shares, Automations "When" picker and crew Wakes;
   - composer `@` and `/`.
   - Start by wiring the built screens to the real server: in the demo (`wisp serve` with the fake claude), `/task/<id>`
     mounts no task view (2026-11-09 check-in).
     Done (docs/v2-round-7.md): six causes fixed; the list and the task mount on `wisp serve`. Left: the row squeeze,
     the list's `status` from `body`, shell-task's stub screens, Home and the composer screens.
   - Each screen is seen in Chrome once (desktop and phone, light and dark); parity/layout/feedback gates run in CI.
8. [ ] **Apps:** the desktop app embeds the core (Tauri, `apps/desktop`); Android gets its own frontend.
9. [ ] **Cutover:**
   - Once our own tasks run on wisp v2, turn on `.wisp/` tracking for this repo (owner, 2026-11-10). Don't backfill the v2 rewrite sessions run on v1.
   - delete v1 (`server/`, `web/`, v1 `grid/`, v1 `desktop/` packaging, v1 tests and workflows);
   - CI workflows for v2 only;
   - budgets (binary ≤ 15 MB, initial JS ≤ 120 KB br);
   - fewer test binaries (one integration-test binary per crate);
   - README and CHANGELOG;
   - `WispAgents/wisp` → `WispAgents/wisp` references.
10. [ ] **Docs and site:** docs.trywisp.dev (ADR-0039, Starlight) and the site rework (`marketing/positioning-v2.md`).
11. [ ] **One batched verification pass:** CI green on every OS, parity/layout/feedback gates, perf budgets, verifier.
   - **wisp from other harnesses, in a wisp-init'ed repo (owner, 2026-11-09; ADR-0033, 0035, 0040).**
     - Setup: a scratch repo with `wisp init` and `.wisp/` committed, holding a few tracked tasks (a transcript, a
       report and Wisp-Task trailers). `wisp skill install --agent claude` and `--agent codex`, plus wisp's MCP server
       added to each harness.
     - **Real runs, in the real Claude Code and Codex CLIs** (not inside wisp):
       - ask "why does this line exist?": the harness uses `wisp_blame` / `wisp_history` / `wisp_task` and answers
         from `.wisp/`;
       - ask "pick up the auth task": `wisp_resume` (with the approval);
       - start a wisp task from the harness through MCP and follow it;
       - commit from the harness: the git hook adds the trailer;
       - the session ends: wisp adopts it (hooks or `wisp adopt`), and it shows in `wisp ls --repo`, the Repo tab and
         the TUI;
       - `wisp open <id> --in codex` continues a Claude task in Codex.
     - **Offline:** the same MCP reads work with no `wisp serve` running (`wisp mcp` offline mode).
     - **Each harness's skills/MCP discovery picks wisp up** with no manual config beyond the install command.
     - **Automated twin in CI:** an e2e with the fake harnesses that calls each MCP tool over stdio against the
       init'ed repo, checks the skill files land where each harness reads them, and checks the trailer and adopt
       round trip. It must exist before the real-run pass.
     - The real runs use the owner's Claude Code and Codex accounts: short prompts, recorded in the round doc with the
       transcripts.
