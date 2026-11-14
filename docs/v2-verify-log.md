# v2 verify log

The verifier's findings: one numbered list per round, newest first. Each item gives its severity
(**blocker** / **must-fix** / **nit**), where it is, what's wrong, and which rule or v1 behaviour it breaks.
Evidence (logs, shots, side-by-sides) is in `qa/out/verify/`.

## Round 4 (partial), 2026-11-08 (`b7556947`..`b6d45e39`; stopped early at the lead's request)

The Rust gates ran on HEAD (the clean build from an export of `b6d45e39`, because the coder's uncommitted
codex work in the tree doesn't compile). The UI gates ran in the tree. Evidence is in `qa/out/verify/r4/`:
`drive.mjs` and `drive.log` (my own `wisp serve` run), `parity-{desktop,browser}/`, `reach/` (all 49 views
at 1440 light), `feedback/` and `sbs/`.

### Gates

| Gate | Result |
|---|---|
| `cargo clippy --workspace --all-targets -D warnings` | ✅ exit 0 |
| `cargo test --workspace` | ✅ 1,498 passed, 0 failed, 14 ignored (302 binaries) |
| `cargo build -p wisp` (fresh target dir, HEAD export) | ✅. In the shared target dir it failed on `RouterState::load_*`: a stale cargo fingerprint (the file's mtime is older than an earlier artifact), not a code bug |
| `cargo deny check` | ✅ |
| `npm run check` / `npm run typecheck` | ✅ / ✅ |
| `monoflow verify --all` (HEAD export) | ✅ 151/151 |
| Parity, home/task/composer, desktop mode | 84/96: **home 24/24**, task 30/36, composer 30/36 (only the 320 shots fail) |
| Parity, browser mode | 84/96, same split |
| `qa/feedback.mjs` (new defaults: both modes at 1440, 390 and 320) | **stopped partway**. home 4 of 6 runs pass, task 6/6, composer 1 run done (pass). 2 failures, see #R4-5 |

### Earlier findings, rechecked

| # | Status | Evidence |
|---|---|---|
| R3-1 question lost on restart | 🟡 **partly** | asked mid-turn, the task waits and stays answerable across a restart (e2e `a_question_asked_mid_turn_survives_a_restart…`). But see #R4-2 when the asking turn ends first |
| R3-2 writes without the task lock | ✅ | `more.rs` takes `task_lock` in `approve_blocked`, `rerun`, `delegate`, `follow_up_with` |
| R3-3 ask/answer/approval parity | 🟡 | live: `waiting`, "Asked you: …", "You answered: dev", options Allow / Always allow in this task / Deny, side-discussion refusal. But Always is too broad, see #R4-1 |
| R3-4 delegate | ✅ | live: `delegate #2` resumed the **same child** (2 turns, same resume id); idle lead → "The lead agent is not running."; cap, empty prompt and unknown member covered by e2e; "Delegated to helper" row |
| R3-5 rerun mark | ✅ | `more.rs:446-455` clears the mark when the follow-up fails |
| R3-6 reply interrupts by default | ✅ | live: a reply 2 s into a second turn stopped it and ran ("two:stopped \| interrupting:done"). It answers `{queued}` where v1 says `{interrupted: true}` (nit) |
| R3-7 / R3-9 store debt | ✅ | My Stuff, crew and router rows in wisp-store with v1 importers. ADR-0020 covers the per-app SQLite. The coverage row records what stays as files |
| R3-8 `btw` outside scope | ✅ | `plugin.rs:59` `RuntimeHost::spawn` → `ctx.spawn` |
| R3-10, R3-11 | 🟡 | `side.rs` uses the kernel clock. `more.rs` approval/results and `finish.rs:274` still use tokio's clock and `tokio::spawn` |
| R2-1 unread title | ✅ | home 24/24. The cause was the parity gate: parallel shots shared one mock, and opening the task marked it read. `qa/parity.mjs` now drops mutate POSTs |
| R2-2 pill / R2-3 footer / R2-4 offset | ✅ | metrics all match at 320 (0 parts off). Pixels still fail, see #R4-4 |
| R2-5 / R2-6 feedback gate | ✅ | text fields submit with Enter; rollback is checked; the default is both modes at 1440, 390 and 320 |

### New findings

1. **blocker** (#R4-1): **"Always allow in this task" allows every use of the tool.** No harness implements
   `Harness::permission` (only the default at `plugins/runtime/api/src/harness/mod.rs:97`, which returns None),
   so `more.rs:275` falls back to `{tool, action: "use Bash", detail: ""}`. Live: after Always on `npm publish`,
   `rm -rf build` was **allowed without asking** ("Allowed (always in this task): use Bash"), and the question
   reads "Allow Claude Code to use Bash?" with no command. v1's claude adapter `permission()` (`actionOf` /
   `detailOf`, `server/adapters/claude.js:721-738`) gives "run \`npm publish\`" and matches the **exact
   command or file** (`sameAction`). Port it into `plugins/claude` (and each harness), and make the e2e test
   check that a different command still asks.
2. **blocker** (#R4-3): **an agent's token acts on every task.** With task L's own token and
   `x-wisp-session: L`, `/api/cmd` let it `runtime.get` and **`runtime.rename`** another task (its title is now
   "renamed by A"), `runtime.followUp` it (a turn started), and `runtime.list` everything (`drive.log` step d).
   v1 edge case *HTTP #3*: "Agent tokens … speak for that session only". `agent:session` allows `runtime:*`
   with no check that the target `id` is the caller's session. Check `args.id` against `caller.session` for
   agent callers, in the kernel or the runtime's commands, with an e2e test. The current e2e test sends a
   garbage token, not another task's.
3. **must-fix** (#R4-2): a question whose turn ends while it's open. Live: the turn that asked finished, the
   task went to `review` **with the question still on it**. After a restart `pollAnswer` said `cancelled`
   (`runtime.rs` rebuilds asks only for `Waiting` tasks), yet a reply still answered it. v1 deletes
   `session.ask` when the turn ends (`runner.js:1812`) and on Stop (`runner.js:1306`). Do the same: cancel the
   ask with its turn.
4. **must-fix** (#R4-4): task and composer at 320 still fail on pixels (1.2 %, 24 regions, **0 metrics off**):
   `sbs/task_desktop-320-light-rest.png`. Below the folded action bar, v1's content moved 5 px and v2's
   4.5 px (`turn.receipt` 377 → 372.5). The half pixel changes the antialiasing of the heading, the commit pill
   and the icons. Find the 0.5 px (likely the bubble or the bar), or have the gate's row cut handle a
   fractional `dh`.
5. **must-fix** (#R4-5): two feedback failures that appear in one mode only, so possibly flaky:
   - home desktop 1440: opening "Fix the login bug" → refused `runtime.markRead` shows **no toast within 100 ms**
     (browser mode passed);
   - home browser 390: Worktree → refused `settings.set`, **no rollback**
     (`feedback/home-browser-390-39-rollback.*.png`; desktop passed).

   Fix the cause, or the gate if it races. AGENTS.md: a flaky test is fixed, never retried.
6. **must-fix** (#R4-6, owner's call): at 390 px the launcher's **Worktree toggle sits half under Send**, in
   v1 too (`sbs/wt-390-crop.png`). Parity passes because v2 copies v1, but foundation.md §4 says nothing is
   clipped, and layout.md §2 says items fold into More. `qa/layout.mjs` has no overlap rule, so add one
   (two items of a bar intersecting).
7. **nit** (#R4-7): `packages/ui/src/css/app-stack.css`, `sh-bar` `padding: calc(var(--space-3) - 1px)`: a
   one-off pixel tweak instead of a token. Fine for v1's 5 px, but add a token named for it.

### UI queue: the 46 v1 views not done (3 of 49 pass)

Found by `qa/parity.mjs --modes=browser --widths=1440 --themes=light` (`reach/parity/summary.json`). Two
unblockers first:
- **(a)** the me-menu has **no Settings item** (`#settingsBtn` → v2), which hides all 13 settings panes;
- **(b)** the task's action bar has no `[data-a=…]` that parity can map, which hides the 9 `task.*` views
  that go through it.

| Owner (v2 plugin) | Not reachable | Reachable, failing |
|---|---|---|
| shell (frame) | `projects` | `palette` (another design, 77 % px), `me-menu` (no `topbar.machines`, no Settings) |
| shell-settings | `settings.general` | |
| accounts / runtime | `settings.agents` | |
| router | `settings.auto` | `home.auto-preview`, `home.compare`, `home.runner` |
| automations | `settings.automations`, `automations.trigger-new` | |
| grid-client | `settings.cloud` | |
| connectors | `settings.connectors` | |
| machines | `settings.machines` | |
| learn | `settings.memory` | |
| channels | `settings.notifications` | |
| telemetry | `settings.privacy` | |
| plugins | `settings.spells` | |
| budget | `settings.usage` | |
| worktrees | `settings.worktrees` | `home.worktree-off` (launcher border colour) |
| shell-home (launcher) | | `home.mode-menu`, `home.team`, `home.where`, `home.typed` (`x.button#27` w 125 → 66) |
| later | | `home.later` |
| goal | `home.goal-judges`, `task.goal-judges`, `task.goal-menu`, `task.composer-goal` | `home.goal-on`, `task.goal` (no `goal.band`) |
| issues | `home.issues` | |
| shell-task | `task.more`, `task.rerun`, `task.transcript`, `task.right-click` (two `card.head` match) | |
| git | `task.changes`, `task.changes-diff`, `task.editor` | |
| ship | `task.ship` | |
| preview (no plugin yet) | `task.preview` | |
| crew | `crew.add` | `crew`, `crew.org` (no `crew.avatar`) |
| stuff | | `stuff` (the My Stuff button doesn't open it, R1 #20) |

Not done this round (stopped): the rest of the feedback run (composer at 390 and 320 in both modes, and at 1440
in browser mode), and a line-by-line review of the router, crew and My Stuff store code.

## Round 3, 2026-11-08 (Rust work since `a2d8ca7d`, HEAD `405ce172`)

Scope: `a1f44024`..`405ce172`: runtime's 42 commands (`more.rs`, `side.rs`), My Stuff (`commands.rs`,
`appdb.rs`), worktrees on the runtime port, MCP server, router (Auto), the crew scheduler, `Ctx::run_json`, and
the serve e2e flows (`crates/wisp/tests/serve_task.rs`). The Rust gates ran on **an export of HEAD**
(`git archive` into `/tmp/wisp-r3-head`), because the working tree has the Rust coder's uncommitted crew
change (`plugins/crew/host/src/store.rs`), which doesn't compile yet. Evidence is in `qa/out/verify/r3/`:
the gate logs, `drive.log` (my own `wisp serve` run, script `drive.mjs`) and `registered.log`.

### Gates (HEAD)

| Gate | Result | Round 2 |
|---|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | ✅ exit 0 | ✅ |
| `cargo test --workspace` | ✅ **1,493 passed, 0 failed**, 14 ignored (302 binaries; the 6 serve e2e flows included) | 1,440 / 4 failed |
| `cargo deny check` | ✅ advisories, bans, licences, sources ok; 11 duplicate warnings | ✅ |
| `npm run check` | ✅ 0 errors, 118 warnings (80 rust-sizes, 29 sizes, 8 i18n, 1 protocol). 15 rules: `openapi` was retired by ADR-0019, which closes R1 #26 | 0 / 114 |
| `monoflow verify --all` | ✅ **151/151 packages** | 117/149 in R1 |
| Manifest commands registered | ✅ all 111 that the 38 manifests declare answer on a live server (none "unknown command") | — |
| Every command in a capability set | ✅ `rust-manifests` passes. `mcp:call` added to `agent:session` (`capabilities.json`) | — |
| Layering | ✅ new deps are `-api` only (crew → runtime-api, worktrees → runtime-api) | — |
| `Ctx::run_json` | ✅ the kernel checks the caller's set and the calling plugin's set (`dispatch.rs` `enter` → `check_sets`), so MCP tools can't run what the user's agent couldn't | — |
| In the working tree (not HEAD) | ❌ `wisp-crew` doesn't compile: `plugins/crew/host/src/store.rs:12` uses `wisp_store`, which isn't a dependency yet (WIP) | — |

### `wisp serve` by hand (fake claude, `FAKE_DELAY=4000`, temp `WISP_HOME`)

| Flow | v2 did | v1 (`server/runner.js`) | |
|---|---|---|---|
| Create | answered in 26 ms; task `running` at once, turn 0 running | same | ✅ |
| Follow-up while a turn runs (no `queue` flag) | **queued** | `reply()` defaults to `queue = false`: it **interrupts** once the agent has reported its session (the fake reports it at init) | ❌ #R3-6 |
| Follow-up with `queue: false` | interrupts: the running turn `stopped`, the new one ran. It answers `{queued}` | `{interrupted: true}` | 🟡 nit |
| Queue + Stop | turn `stopped`; queue `["third"]` kept, `queueHeld: true`, still held 5 s later | same | ✅ |
| Follow-up after Stop | `fourth` ran, then the held `third` | "you're back: a queue a Stop held carries on after this" | ✅ |
| Ask while running | `ext.ask` set, `unread: true`; **state stays `running`**; **no activity row** | `state = 'waiting'`, un-archived, a "Asked you: …" row on the turn, a `finished` notification | ❌ #R3-3 |
| Reply answers the ask | no new turn; `pollAnswer` → `answered: dev` | same, plus a "You answered: dev" row on the turn | 🟡 #R3-3 |
| **Restart with a question open** | the question is **still on the task** (`ext.ask` = "Still there?"), but `pollAnswer` says `cancelled`, `runtime.answer` is refused ("Nothing is being asked on this task."), and a reply starts a new turn **with the question still showing** | `session.ask` is in the store, so `pollAnswer` stays `pending` and the reply answers it | ❌ #R3-1 |

### Findings

**Must-fix**

1. **must-fix** (#R3-1): `plugins/runtime/host/src/runtime.rs:37` keeps open questions only in memory
   (`asks: Mutex<HashMap<…>>`), while the question itself is persisted on the session (`more.rs:107`, `ext.ask`).
   After a restart the task shows a question nothing can answer (seen above: answer refused, the reply starts a
   new turn, the question stays). Derive "is asking" from the persisted `ext.ask`, as v1's `pollAnswer` reads
   `session.ask` from the store. On start, either clear stale asks with an activity row, or keep them answerable.
   Add a serve e2e test that restarts.
2. **must-fix** (#R3-2): lost updates. `more.rs:178-194` `approve_blocked` and `more.rs:289-305` `rerun` read the
   session, change it and `persist` it **without `task_lock`**, which every other writer takes (`ask`, `answer`,
   `put_btw`, `overage`). A turn finishing in between is overwritten with the stale copy. Take the lock for the
   read-modify-write, then release it before `follow_up`, which locks itself.
3. **must-fix** (#R3-3): `ask`/`answer`/`approval` vs v1 (`runner.js:950-1100`):
   - **`ask`:** no `state = waiting`, no un-archive, no "Asked you: …" activity row on the turn, no
     notification. It also has no 6-option cap and no "The agent has a question." default.
   - **`answer`:** no "You answered: …" row.
   - **`approval`** (`more.rs:162`): offers **Allow / Deny** only. v1 offers Allow, **Always** and Deny, where
     Always adds a task-scoped grant that later approvals pass without asking (`session.grants`, `sameAction`).
     v1 also records denials so the blocked card doesn't offer them again (`turn.denied`).
   - **`approve_blocked`:** doesn't refuse Allow on a side discussion (v1:
     "A side discussion can't allow this: ask the main task to do it.").
4. **must-fix** (#R3-4): `more.rs:339` `delegate` isn't v1's (`runner.js:1108-1176`):
   - It takes `agent:model` strings instead of the lead's **team roster** (`lead.subagents`), so "No subagent
     named …" and "This session has no subagents yet" are gone.
   - It doesn't refuse when **the lead isn't running**.
   - It doesn't **resume each member's child task** (`lead.children[slot]`): every call makes a new task.
   - It has no busy copies (`codex#2`, "still working… Wait with subagent_results").
   - It doesn't refuse an **empty prompt**.
   - The child doesn't inherit the lead's **cap** (edge case *Channels #3*: "capped tasks stay capped for
     every follow-up and child").
   - It doesn't record `turn.delegations` or the "Delegated to …" activity row, so `results` can't tell
     delegations apart from the lead's other children.
5. **must-fix** (#R3-5): `more.rs:298`: `rerun` persists its once-only mark before `follow_up`. If `follow_up`
   fails, the mark stays, and the signed-out card never offers the rerun again. v1 deletes
   `turn.signedOut.rerun` on failure (`runner.js:2036`) and asks the guard first (`hold`).
6. **must-fix** (#R3-6): `runtime.rs:318` defaults `followUp.queue` to **true**. v1's `reply` defaults to
   `false`: a reply interrupts the running turn once the agent's session is known. Any client that omits the
   flag (MCP `wisp_reply`, channels, scripted CLI) now waits where v1 interrupted. Either default to v1's, or
   record the change in an ADR and make every client send the flag. The api doc comment
   (`commands/tasks.rs:113`) already states the new default, so this is a decision to record, not a slip.
7. **must-fix** (#R3-7): a **new write path** not on the coder's known-debt list (router.json, crew.json,
   FsBlobs). `plugins/stuff/host/src/lib.rs:49` keeps **My Stuff's rows as one JSON file each**
   (`JsonRows`, `ports.rs:151-199` → `<home>/stuff/rows/*.json`), and `serve_task.rs` asserts that directory.
   ADR-0004 says one write path: rows go through `wisp-store`, recorded in `change` so clients can subscribe.
   My Stuff's list isn't in the change feed. Also, `plugins/stuff/host/src/appdb.rs` gives each app its own
   SQLite (v1's app-db): that's user data, so fine in spirit, but it's a new kind of state and a direct
   `rusqlite` dependency in a plugin host. Record both in an ADR (the AGENTS.md rule for a new kind of state).
8. **must-fix** (#R3-8): `more.rs:244` `btw` starts its side run (a child process, up to 300 s) with a bare
   **`tokio::spawn`**, not `ctx.spawn`/`ctx.scope`. Switching the runtime off won't stop it (AGENTS.md: every
   timer and child process goes through `ctx.scope`).
9. **must-fix** (#R3-9): the known debt (router.json, crew.json, FsBlobs) isn't written down anywhere in the
   repo: no ADR, no coverage row. Add a "debt" line to `docs/v2-plan-coverage.md` §4.1 so it isn't forgotten.
   The crew part is being moved into the store in the working tree now.

**Nits**

10. **nit** (#R3-10): `more.rs:55`: `unwrap_or_else(|| unreachable!(…))` is a panic outside tests (§9.2 says no
    panics). Restructure, e.g. `match v { Value::Object(o) => o, _ => … }` after the replace.
11. **nit** (#R3-11): host-side waits read tokio's clock, not the kernel `Clock` service, so they can't be
    driven by FakeClock in tests:
    - `more.rs:164,370` (approval and results deadlines);
    - `side.rs:61` (side-run deadline);
    - `plugins/mcp/host/src/run.rs:89,155`;
    - `plugins/crew/host/src/jobs.rs:198` (20 s tick; this one is correctly on `ctx.spawn` + scope).
12. **nit** (#R3-12): the ask e2e test (`serve_task.rs` `an_agents_question_is_answered_by_the_reply`) asks
    **after** the turn ended. A real ask happens while the turn runs, with the agent blocked in its MCP call.
    Ask during a `FAKE_DELAY` run, and check the state, the activity rows and the restart case (#R3-1).
13. **nit** (#R3-13): commit hygiene: `405ce172` is titled "chore(v2): remaining coder changes". Name what it
    changes.

### Round-1/2 items this closes
R1 #1–#4, #6, #7 (workspace compiles, clippy clean, tests green), #25 (every plugin in the binary; every host
has a manifest; all 111 manifest commands registered), #26 (OpenAPI rule retired, ADR-0019). R2's 4 failing
Rust tests pass.

### Top 5 for the Rust coder
1. #R3-1: a restart leaves an unanswerable question. Use the persisted `ext.ask` as the truth.
2. #R3-2: `approve_blocked` and `rerun` write without the task lock.
3. #R3-3: ask/answer/approval parity: waiting state, activity rows, **Always** grants.
4. #R3-4: `delegate` against the lead's team: resume members, refuse when the lead isn't running, inherit the cap.
5. #R3-7: My Stuff's rows into `wisp-store` (or an ADR), and the app-db as a recorded kind of state.

## Round 2, 2026-11-08 (HEAD `ba026595`; the Rust gates were skipped, their counts are at the end)

Scope: home, task and task.composer, which the UI coder reports done, in desktop mode and browser mode, at
every width. Evidence is in `qa/out/verify/r2/`: `parity-{desktop,browser}/`, side-by-sides in `sbs/`
(v1 left, v2 right), `feedback/` and `layout.json`.

### What changed in the gates this round (the lead's decision on 320 px)

At 320 px v2 keeps ADR-0012's no-wrap layout where v1 wrapped a bar. I recorded that as
`design/v1-reference/allowed.md` §4 (`fold` rules: `launcher.projects`, `split.actions`, `split.head`,
`panel.head`, `topbar`) and taught `qa/parity.mjs` to apply it.

How a fold is applied, on shots ≤ 320 px only:
- the folded bar is masked, and what v1 drew inside it is skipped;
- everything below is compared moved up by the height v2 saved, in the metrics and in the pixels (v1's
  rows are cut);
- content pinned to the bottom (composer, overlap note) stays where it is;
- a box around the bar is shorter only when v2's is.

The fold is allowed only when `qa/layout.mjs`'s checks find nothing on that same v2 page. For that, `inspect`
is now exported from `qa/layout.mjs` (which runs `main()` only as a script). It works: every 320 shot folds
(`shotsBy[*].folds`), and task at 320 drops from 5.6 % to 2.0 % px differing. What still fails at 320 is
real v2 differences, listed below.

### Gates

| Gate | Result | Round 1 |
|---|---|---|
| `qa/parity.mjs --modes=desktop` (3 views) | 60/96: home 0/24, task 30/36, composer 30/36 | 48/96 |
| `qa/parity.mjs --modes=browser` (3 views) | 60/96: same split | 3 views not run separately |
| — passing widths | task and composer pass every width but 320. Home fails only on #R2-1 at 600–1440 | |
| `qa/layout.mjs --area=shell` | ✅ 0 problems (5 pages × 6 widths × 2 themes) | could not run |
| `qa/layout.mjs` (gallery) | ❌ 4 problems, overflow-x at 390/320 (code, diff-body) | 4 |
| `qa/feedback.mjs` (browser, 1440 + 390) | ✅ 185 pass, 0 fail, 14 skipped (12 current, 2 disabled) | didn't exist |
| `qa/feedback.mjs --modes=desktop --widths=1440,320` | ✅ 179 pass, 0 fail, 13 skipped | didn't exist |
| `npm run check` / `npm run typecheck` | ✅ 0 errors, 114 warnings / ✅ | ✅ / ✅ |
| monoflow `--package` @wisp/ui, web, shell, client, tokens | ✅ each | ui and web failed |

### Round 1 findings, rechecked

| R1 # | Status | Evidence |
|---|---|---|
| 5 blank task render | ✅ fixed | task 1440/1024/900/600/390 pass in both modes |
| 8 monoflow UI failures (css-rules, slots.test) | ✅ fixed | @wisp/ui and @wisp/web pass |
| 9 v1 reference rewritten, not deterministic | ✅ fixed | `ba026595` recaptured with a pinned clock per view. Two parity runs gave identical metrics |
| 10 layout gate can't find the app | ✅ fixed | `layout --area=shell`: 0 problems, 60 page-shots |
| 11 gallery overflows at 390/320 | ❌ open | `qa/out/verify/r2/gal/layout/` |
| 12 parity counts no-reference views as ✔ 0/0 | ✅ fixed | `qa/parity.mjs:635` says "no reference: not covered" |
| 13 composer row runs out of its card at 900 | ✅ fixed | home 900: 0 launcher parts off |
| 14 heading truncated at 320 | ✅ fixed | `sbs/home_desktop-320-light-rest.png`: wraps to 2 lines as in v1 |
| 15 tip buttons drop below the text at 600 | ✅ fixed | home 600: 0.0 % px, 0 regions |
| 16 turn footer on 3 lines at 600 | ✅ fixed at 600. At 320 v1 wraps too, but see #R2-3 | task 600 passes |
| 17 task head squeezed at 320 | 🟡 partly | branch has its own line now; the pill is still cut, see #R2-2 |
| 18 composer focus ring lost | ✅ fixed | home 1440 focus 0.1 % px; `sbs/task.composer_desktop-1440-light-focus.png` matches |
| 19 palette is a different design | ⬜ not rechecked | palette is out of this round's views |
| 20 My Stuff does nothing | ⬜ not rechecked | |
| 21 32 views not reachable | ⬜ not rechecked | the coder hasn't claimed them |
| 22 `optimistic: 'none'` without `pending` | ✅ fixed | `packages/client/src/commands.ts:22-46`: union type, test in `commands.test.ts`; ADR-0018 |
| 23 New task waits for the server; follow-up not optimistic | ✅ fixed | `HomeView.tsx:63-74`: client id (uuidv7), optimistic Starting row, navigates at once. `frame/commands.ts:62` followUp has an optimistic patch |
| 24 `'claude'` hard-coded in the shell | ✅ fixed | no `'claude'` left in `packages/shell/src`; harnesses come from `PluginUiDef.harnesses` (`plugins/claude/ui/src/index.ts`), ADR-0018 |
| 1–4, 6, 7, 25 (Rust) | skipped this round | the Rust coder is on them |
| 26–30 nits | open | not rechecked |

### New findings

1. **must-fix** (#R2-1): on home at 1440–390, both modes, `card.title#3` ("Fix the login bug") is
   **fw 500 and colour rgb(61,61,61) in v2**, where v1 has **fw 600 and rgb(23,23,23)** (dark mode: 199 vs 237).
   The recapture is deterministic, so this is v2 not drawing that row's unread state (v1 bolds an unread
   task's title). It's the only metric off on home at 600–1440. The 4–8 regions over 8×8 px are that title
   plus antialiasing at the launcher's top-left corner and the Send button's corner:
   `r2/parity-desktop/home/desktop-1440-light-hover.diff.png`.
2. **must-fix** (#R2-2): `sbs/task_desktop-320-light-rest.png`. The task head cuts the project pill to
   **"wisp-r…"**, but the row has about 150 px free to its right. v1 shows "wisp-repo-ZaGhoN" in full. A pill
   truncates only when its row is out of room (layout.md §4). This shows in every task and composer shot
   at 320.
3. **must-fix** (#R2-3): `sbs/task_desktop-320-light-rest.png`. In the turn footer at 320, v1 puts
   **"1 file +1 −1" right-aligned** on its line, with the action icons right-aligned below. v2 left-aligns it
   (`x.button#6` x 239.5 → 18), and the three icons are 3 px off (`turn.fork` x 278 → 281). Both of v1's lines
   are its own wrap of the footer, so match its alignment.
4. **must-fix** (#R2-4): on home at 320 the launcher card sits **1.5 px lower** than v1's (`launcher#0` y 64 →
   65.5), and the heading and Back button 1 px lower (`split.greeting` 5 → 6, `split.back` 6 → 7). The
   offset carries through the launcher's contents and is most of the remaining 4.7 % px on home at 320.
5. **must-fix** (#R2-5): the feedback gate doesn't test the two commands that matter most.
   - It "presses" a text field by typing one character, which sends nothing, so `runtime.create` (New
     task) and `runtime.followUp` (reply) are **never exercised or refused** (the 36 commands it sent were
     markRead, setState, forLater, ship.open, checkpoint.restore, fork, settings.set). Press Enter after typing.
   - It checks for a toast but **not the rollback** design/feedback.md §3 requires (the row, title or text
     back as it was).
   - It waits up to DELAY + 100 + 300 ms, where the spec says "toast within 100 ms of the refusal" and
     the code comment says `BUDGET`. Drop the +300.

   File: `qa/feedback.mjs:196-220`.
6. **must-fix** (#R2-6): `qa/feedback.mjs` defaults to browser mode at 1440 and 390. The owner uses the
   desktop app, so run `--modes=desktop` by default as well, and 320. (I ran it: see the desktop line below.)
7. **nit** (#R2-7): `ba026595` is titled "qa: deterministic v1 re-capture" but also carries ADR-0018, the
   `CommandDef` union, the harness contract and 400 lines of frame UI. A reviewer reading the log won't find
   them. Split commits by concern from now on.
8. **nit** (#R2-8): new size warnings in the frame:
   - `packages/shell/src/frame/TaskView.tsx:46` is 231 lines, with a 128-line closure at :146;
   - `HomeView.tsx:34` is 141 lines;
   - `packages/ui/src/app/Home.tsx` is 423 lines (Launcher, 146);
   - `packages/ui/src/app/Task.tsx` is 443 lines.

   Split them before the plugins take these screens over (ADR-0018 §3).

### Rust (counts only, as asked; HEAD with the Rust coder's work, not reviewed)

- `cargo clippy --workspace --all-targets -- -D warnings`: ✅ exit 0. In round 1 it didn't compile, so R1 #1–#4
  and #6 look fixed (not re-reviewed line by line).
- `cargo test --workspace --no-fail-fast`: compiles. 1,440 passed, **4 failed**, 14 ignored, in 301 binaries.
  - `wisp-channels-core --test policy`: `untrusted_is_wrapped_and_its_text_cant_close_the_wrapper`. The name
    sanitiser test from R1 #7 passes now; this is a new failure.
  - `wisp-telemetry-core --test telemetry`: 3 tests (`counting_through_the_off_switch_and_what_leaves`,
    `feedback_goes_out_…`, `capture_error_…`). These are R1 #7, still open.

  Logs: `qa/out/verify/r2/{clippy,ctest}.log`.

### Where the coder should go next

Fix #R2-1 (unread title), #R2-2 (pill) and #R2-3 (footer alignment), and the 1.5 px launcher offset (#R2-4).
With those, home and task would pass at every width in both modes. Then make the feedback gate submit
text fields and check rollbacks (#R2-5).

## Round 1, 2026-11-08 (HEAD `445147ee` plus the coder's uncommitted work)

### Gates

| Gate | Result | Log |
|---|---|---|
| `npm run check` | ✅ 0 errors, 109 warnings (75 rust-sizes, 25 sizes, 8 i18n, 1 protocol) | `qa/out/verify/check.log` |
| `npm run typecheck` | ✅ exit 0 | `qa/out/verify/tsc.log` |
| `cargo clippy --workspace --all-targets -D warnings` | ❌ **does not compile**: 4 api crates (ts-rs), plus 4 lint errors | `qa/out/verify/clippy.log` |
| `cargo test --workspace` | ❌ **does not compile** (crew-api, grid, machines-core test). Without the 20 broken crates: 1,181 passed, **5 failed**, 13 ignored | `qa/out/verify/ctest4.log` |
| `cargo deny check` | ✅ advisories, bans, licences, sources ok; 11 duplicate-crate warnings | `qa/out/verify/deny.log` |
| `monoflow verify --all` | ❌ 117/149 packages pass; 32 fail | `qa/out/verify/monoflow.log` |
| `qa/parity.mjs --modes=desktop` | ❌ 48/96 shots (home 0/24, task 24/36, composer 24/36); the other 46 views have no desktop reference | `qa/out/verify/parity-desktop/` |
| `qa/parity.mjs --modes=browser` | ❌ 71/486 shots; **32 of 49 views not reachable** in v2 | `qa/out/verify/parity/` |
| `qa/layout.mjs` (kit gallery) | ❌ 4 problems (overflow-x at 390 and 320) | `qa/out/verify/layout-gallery.log` |
| `qa/layout.mjs --area=shell` | ❌ cannot run: its selectors are stale, so every page "never showed" | `qa/out/verify/layout-shell.log` |
| `qa/feedback.mjs` | ⬜ doesn't exist yet (design/feedback.md says a screen isn't done without it) | |

Per-crate test counts: wisp-store 78, wisp-kernel 64, wisp-sync 32, wisp-proc 30 (with g12), wisp-api 61: all pass.

### Findings

**Blockers: the workspace doesn't build at HEAD**

1. **blocker**: `plugins/connectors/api/src/rows.rs:39`, `plugins/router/api/src/types.rs:33,283,295`, and the other
   E0277 sites in `plugins/{automations,crew}/api` (16 in all). `#[ts(optional)]` is on non-`Option` fields (`bool`,
   `Vec<_>`), and ts-rs 12.0.1 (the version in Cargo.lock) refuses it. So `cargo build`, clippy and test fail for
   the whole workspace. Use `#[ts(optional)]` only on `Option<T>`. For a skipped `bool`/`Vec`, use
   `#[ts(as = "Option<bool>", optional)]` or drop the attribute. Rule: AGENTS.md *Commands* and §9.2 (clippy -D
   warnings from the first commit). The audit's claim that CI runs clippy and test (`docs/v2-quality-audit.md`)
   can't be true on this tree.
2. **blocker**: `plugins/crew/api/src/lib.rs:9-10` declares `pub mod commands; pub mod events;`, but neither file
   is committed (`git ls-files plugins/crew/api/src` lists only lib.rs and rows.rs). That's 34 errors, and wisp-crew
   and crew-core fail with it.
3. **blocker**: `apps/grid/src/pages.rs:11,13,14,20` declares modules `account`, `device`, `home` and `share`,
   whose files are missing. `apps/grid/src/pages/site.rs:48` puts an HTML literal in a normal string, so `report"`
   parses as a reserved prefix and needs a raw string. `apps/grid/src/pages/signin.rs:6` imports a `super::join`
   that doesn't exist. wisp-grid doesn't compile.
4. **blocker**: `plugins/machines/core/tests/resume_bench.rs:24`: `["claude","codex","opencode"][i % 3]` inside
   `json!` doesn't compile. Bind it to a local first.
5. **blocker**: `qa/out/verify/parity/task/1440-light-hover.v2.png` is an **empty white page**: v2 renders
   nothing for the task view in the 1440 light hover capture (29.8 % px differ). 1440 dark hover is fine, so it's
   either a race in first render or a crash. Check the console in that state.

**Must-fix: gates and tests**

6. **must-fix**: clippy lints that will show once item 1 compiles: `plugins/mcp/api/src/lib.rs:62`
   large_enum_variant (box `Plan`); `plugins/later/api/src/commands.rs:241` struct_excessive_bools;
   `plugins/later/api/src/model.rs:8` trivially_copy_pass_by_ref (`is_false(b: &bool)` is required by serde's
   `skip_serializing_if`, so add a local allow with a reason); `plugins/automations/api/src/words.rs:294`
   semicolon_if_nothing_returned.
7. **must-fix**: 5 Rust tests fail.
   - `plugins/channels/core/tests/policy.rs:137`: the sender name sanitiser strips the space, so it gives
     `"AdaLovelace"` where the test expects `"Ada Lovelace"`.
   - `plugins/telemetry/core/tests/common.rs:67`: 3 tests fail because their goldens
     (`plugins/telemetry/core/tests/goldens/*.json`) were never committed (AGENTS.md *Tests*: goldens are
     committed).
   - `plugins/telemetry/core/tests/telemetry.rs:105` expects `2026-11-07`, gets `2026-11-06`: the test depends on
     today's date or the time zone. Inject the clock (sans-IO core, AGENTS.md). As written it's a flaky test.
8. **must-fix**: `monoflow verify --all` gives 117/149. Besides the Rust crates above:
   - `packages/ui/test/css-rules.test.ts:35`: `app-frame.css` is no longer one `@layer` block (text follows the
     layer's close).
   - `packages/ui/test/css-rules.test.ts:62`: `app-task.css` has a raw `860px` outside `@media`/`@container`,
     where token px are required.
   - `apps/web/test/slots.test.tsx` (untracked, WIP): monoflow typechecks it without JSX, so every JSX line errors.
     `npm run typecheck` passes while monoflow fails: make the two configs agree (ADR-0001, monoflow is the gate).
9. **must-fix**: **the committed v1 reference is being rewritten** in the working tree (56 files under
   `design/v1-reference/{home,task,task.composer}`, plus 98 new `desktop-*` shots). The rewritten `metrics.json`
   keeps the **old `captured` stamp**, yet values changed. For example `card.title#0` went from fw 500 to 600, and
   `launcher.worktree` moved from x 1144.5 to 1136.5. foundation.md §1 says the reference "is committed and never
   edited by hand". Two captures of v1 disagreeing means the capture isn't deterministic (unread state,
   relative times, the clock). Fix the seed and clock in `qa/v1-reference.mjs`, recapture with a new
   `captured` stamp, and commit the reference on its own, with the reason. v2 currently fails because of it:
   `card.title#3: fw 600→500` on every home shot.
10. **must-fix**: `qa/layout-areas.mjs` can't find the app. It waits for `[data-kit="frame"]`, but the frame is now
    `[data-kit="stage"]` (`packages/ui/src/app/Stage.tsx:35`), and the paths (`/task/local%3As0000`) don't match the
    parity seed. So **the layout gate checks no app screen**, only the gallery. It also logged a real page error at
    home 320: `props.filter is not a function` (`packages/shell/src/frame/Sidebar.tsx:101/127`: something renders
    `Head`/`SidebarList` with a non-function `filter`).
11. **must-fix**: the kit gallery overflows horizontally at 390 and 320 px, because of `code` and `diff-body`
    (page 489 px wide at 390). A code or diff block has to scroll inside its own box (layout.md §6 overflow-x).
    Shots: `qa/out/verify/layout/`.
12. **must-fix**: `qa/parity.mjs` reports a view with no reference shots for the mode as `✔ 0/0` (46 views in
    desktop mode). It should say "no reference" and count as not covered. Desktop references exist only for home,
    task and task.composer, and the owner uses the desktop app.

**Must-fix: what the screens show** (side-by-sides, v1 left and v2 right, in `qa/out/verify/sbs/`)

13. **must-fix**: `sbs/home_desktop-900-light-rest.png`. The composer's second row (Recipes · prompt · New)
    **runs out of the card**: "+ New" sits on the card's right border and is clipped by the pane edge. The first
    row shows every icon, but v1 at 900 drops "in", turns *Other folder…* into an icon, ellipsizes the recipe text
    and shows *Issue* as an icon. Rules: nothing is clipped except by an ellipsis (foundation.md §4), and bars
    collapse (layout.md §2). 13/167 parts off, e.g. `launcher.issue` x 829→894.
14. **must-fix**: `sbs/home_desktop-320-light-rest.png`. The heading reads **"What should wis…"**: v2 truncates
    content text. v1 wraps it onto two lines, because a heading is content (layout.md §1). The location row clips the
    *Other folder* icon at the card edge, where v1 wraps that row. Under ADR-0012 it collapses into More and
    never clips. The Recipes block also differs: v1 shows "Prompts you send…" under Recipes, then New.
15. **must-fix**: `sbs/home_desktop-600-dark-rest.png`. The tip cards put **"Sign in →" / "Set up →" on their
    own line below the text** (card 108 px tall, v1's 80). v1 keeps the button on the right, centred on the row.
16. **must-fix**: `sbs/task_desktop-600-light-rest.png` and `task_desktop-320-light-hover.png`. A turn's
    footer is one line in v1: stats on the left, "1 file +1 −1" and the three action icons on the right. v2
    **breaks it into three lines** (stats / diff / icons), which moves `turn.fork` y from 352.5 to 399. A bar has
    wrapped (layout.md §2: one line, always).
17. **must-fix**: `sbs/task_desktop-320-light-hover.png`. The task head squeezes the branch onto the status row,
    so the project pill shows "wisp-r…" and the branch "wisp…-784f69". v1 gives the branch its own line and shows
    the pill in full (`target#0` y 117→97, h 57→52). Hover, focus and rest all fail at 320.
18. **must-fix**: `sbs/home_desktop-1440-light-focus.png`. In the focus state v1's launcher keeps its accent
    border, while v2's composer border is grey. A focus ring is lost (0.6 % px, over the 0.5 % budget). The
    top-right avatar (`me`) is also a differing region over 8×8 on every home shot
    (`parity-desktop/home/*-rest.diff.png`).
19. **must-fix**: `sbs/palette_1440-light-rest.png`. The palette is **a different design**:
    - a centred dialog titled "Command palette" with a close button, where v1 has an untitled search popover
      anchored near the top of the main pane;
    - a "Go to → What's using my computer" section v1 doesn't have;
    - every task subtitled "Review" instead of v1's `project · status · time` on the same line;
    - no Crew section and no Actions section (New task N, Start from an issue…), and its own `wisp` section of
      theme toggles;
    - the footer hint styled differently.

    77 % px differ.
20. **must-fix**: `sbs/stuff_1440-light-rest.png`. Clicking **My Stuff** in the sidebar **does nothing**: Home stays
    on screen. That breaks feedback.md (a click with no visible change) and leaves My Stuff unreachable.
21. **must-fix**: 32 of 49 reference views are **not reachable** in v2 (their opener's click times out):
    - every `settings.*` pane (13);
    - `crew`, `crew.add`, `crew.org`, `projects`, `automations.trigger-new`;
    - `home.issues`, `home.goal-judges`;
    - `task.changes`, `task.changes-diff`, `task.composer-goal`, `task.editor`, `task.goal-judges`,
      `task.goal-menu`, `task.more`, `task.preview`, `task.rerun`, `task.ship`, `task.transcript`;
    - `task.right-click` (a strict-mode violation: two `card.head` match the title).

    The reachable launcher variants (home.mode-menu, runner, team, goal-on, auto-preview, compare, where, later,
    worktree-off) all fail, usually because the menu or popover isn't drawn (`launcher.mode bg → -`,
    `x.button#37 missing`).

**Must-fix: architecture and rules**

22. **must-fix**: `packages/client/src/commands.ts:24`: `CommandDef` has **no `pending` field**, and
    `optimistic: 'none'` type-checks on its own. design/feedback.md requires *"`optimistic: 'none'` without
    `pending` is a type error"*. Nine commands use `'none'` with nothing else, e.g.:
    - `packages/shell/src/frame/HomeView.tsx:24` and `TaskView.tsx:34`;
    - `plugins/crew/ui/src/more/commands.ts:31,39,46,53`;
    - `plugins/stuff/ui/src/commands.ts:51`.
23. **must-fix**: `packages/shell/src/frame/HomeView.tsx:46-47`: a new task **waits for `runtime.create`'s
    answer, then navigates** (`.then((r) => navigate(openTask r.id))`). feedback.md §2 and §3 say to navigate at
    once and show the row and page in a *Starting* state. `TaskView.tsx:34,57`: a follow-up is `optimistic: 'none'`,
    so the message doesn't appear in the transcript (or the queue) until the peer answers. v1 shows it at once.
24. **must-fix**: `packages/shell/src/frame/HomeView.tsx:46,52` hard-codes `agent: 'claude'` and
    `HARNESS['claude']`, and `frame/rows-view.ts` holds a `HARNESS` table that `Sidebar.tsx:132` reads. AGENTS.md
    and ADR-0003 say the kernel and shell know no feature, with "no `harness === 'claude'` outside plugins/claude".
    The default harness and each harness's mark come from the harness plugins through an extension point.
    Relatedly, the frame's fallback `HomeView`/`TaskView`/`SidebarList` re-implement what the `shell-home`,
    `shell-task` and `shell-list` plugins own. Either the plugins draw these screens, or say in an ADR why the
    shell owns them.
25. **must-fix**: only **6 of the 40** plugins in `crates/wisp/src/groups.rs` `DEFAULT` are compiled into the binary
    (`crates/wisp/Cargo.toml` features: git, worktrees, ship, review, issues, machine). runtime, settings and every
    harness are missing, so `wisp serve` can't run a task. Also, **23 plugin hosts have no `wisp-plugin.json`
    and implement no `Plugin`**: accounts, antigravity, channels, claude, codex, connectors, copilot, cursor, discord,
    email, github, grok, lsp, mcp, ntfy, opencode, plugins, settings, slack, telegram, telemetry, terminal, update.
    `rust-manifests` only checks crates that implement `Plugin`, so it passes without checking them, and "every
    command is in a capability set" is unchecked for those 23.

**Nits**

26. **nit**: `tools/check/rules/openapi.ts` reads routes from `apps/server/src` (v1, deleted), so it checks
    nothing. The Rust edge builds `/openapi.json` from its route table (`crates/wisp-api/src/own.rs:39`), so
    routes are documented by construction. Point the rule at the Rust table, or retire it with a note.
27. **nit**: the plan coverage table says kernel "72 tests". `cargo test -p wisp-kernel` runs 64.
28. **nit**: `plugins/shell-settings/ui/src/panes/General.tsx:76-88`: the i18n rule flags `title="shell-settings.tui"`
    and 7 more. Either it's a false positive (a key handed to a component that calls `t`), so teach the rule, or
    wrap them in `t()`.
29. **nit**: 75 Rust functions over 60 lines and 25 TS components over 60 lines (warnings only).
    `cargo deny`: 11 duplicate crates (getrandom ×3, thiserror, syn, rand, bitflags…).
30. **nit**: home rows show "Finished" with a one-pixel antialias difference at the dot (`card.status`). Below the
    glyph rule, so no action unless the metric is off.

### What the coder should do first

1. Make the workspace compile (items 1–4), then clippy (6), then the 5 tests (7).
2. Restore one deterministic v1 reference (item 9) before chasing more parity.
3. Fix the layout breaks a user sees on the done screens: composer at 900 (13), turn footer (16), tip cards (15),
   heading at 320 (14), task head at 320 (17), the blank task render (5).
4. Commands: add `pending` to `CommandDef`, then make New task and follow-up answer at once (22, 23).
5. Repoint `qa/layout-areas.mjs` at the stage so the layout gate checks the app (10).
