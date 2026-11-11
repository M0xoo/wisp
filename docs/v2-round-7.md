# v2 round, item 7: the GUI. First step: the built screens on the real server

The check-in found that `/task/<id>` mounted nothing against `wisp serve`. I followed it with a real `wisp serve` (scratch home, the fake agent, `apps/web/dist`) in headless Chrome. It had six causes, each fixed at its root.

## Fixed

1. **Plugins were dropped at registration, without a word.**
   - Cause: `shell.register` refused any catalogue key outside the plugin's namespace. `main.tsx` catches the error (one bad plugin never stops the app) and only records it in devtools, so five plugin UIs never loaded: shell-task, crew, goal, later and router.
   - shell-task bundled the kit's `block.*` strings. The four others name their strings by their full id (`wisp.crew.…`).
   - Fixes:
     - The shell registers the blocks' copy (`BLOCK_STRINGS`, owner `block`) beside the kit's own strings, and shell-task stops bundling it.
     - A string may now start with the plugin's full id as well as its namespace, the same rule extension ids already had. Full-id keys are registered under the id, so each key still has one owner.
   - Test: `apps/web/test/plugins.test.tsx` "every plugin UI registers, and the frame areas have their plugins".
2. **A bare id in a URL named no peer.** `/task/<id>` (the link the CLI prints) put `<id>` in nav, while every row is keyed `<peer>:<id>`, so the task view found no row. Both the first URL and `client.start()`'s restore now give a bare id (main and `?side=`) the home peer's key (`homed()` in `nav-url.ts`). A key that names its peer is kept. Test: `packages/client/test/nav.test.ts` "a bare task id in a URL is the home peer's task".
3. **The frame's task view watched the wrong topic** (`session:<peer>:<id>`), so no turn ever arrived. It now watches `session:<id>`, and finds turns by the bare `session_id` the server sends, or by the key an optimistic turn carries.
4. **shell-task attached to areas the frame never renders** (`shell.app:main` and `shell.app:side`, the override areas). It also read the shell through a private context nobody provided.
   - shell-task and shell-list now use `@wisp/shell`'s `useShell` and `ShellProvider`; the provider is now exported. Their own comments said "switching over is one edit, here".
   - shell-task's screens are still stubs: `TaskHead`, `Transcript`, `PlanView`, the cards and `SidePanel` all render nothing. An extension on `shell.screen:task` replaces the frame's working task view, so its extensions stay off, with the attach lines in a comment, until those screens are built. Attaching stubs would have made the screen blank again.
5. **The task list was never registered.**
   - shell-list, shell-home and shell-composer have no `index.ts`, so `plugins.ts` skipped them. shell-list's `TaskList` was ready, so it now has an entry on `shell.sidebar:list` and a catalogue. Its strings had none (about 120 keys, including the templated `section.*`, `status.*` and `pr.*` and the `tx()` keys in the model), and `list.here.*` were outside its namespace (now `shell-list.here.*`).
   - The kit's `feed-wrap` is a flex column now, so a growing list gets the sidebar's height. It was 0 px.
   - shell-home has models only (no component), and shell-composer has parts but no screen. Both are left as they are.
6. **router showed a debug pill** ("1 rows", the scaffold's probe) over the list once it registered. Its probe is detached.

## Seen

- Real `wisp serve` with the fake agent, Chrome at 1440 (dark and light) and 390 (dark): `docs/qa/round7-task-*.png`.
- The list shows "Needs you" and the row. The task shows its request, the answer (the fake agent's "Claude Code failed"), the stats, the actions and the composer.
- `npx tsc --noEmit` is clean for `packages/client`, `packages/shell`, `apps/web`, `plugins/shell-list/ui`, `plugins/shell-task/ui` and `plugins/router/ui`.

## Round 2 (after the TUI's look)

Fixed, and seen on a real `wisp serve` in Chrome at 1440 (dark and light) and 390 (light):
- `docs/qa/round7-task-1440-dark.png`
- `docs/qa/round7-task-1440-light.png`
- `docs/qa/round7-list-390-light.png`

1. **The list read `status` from the wrong place.** A server session row has three parts: its hot columns at the top (`id`, `title`, `state`, `updated_at`…), the rest in `body`, and the list's own view in `summary` (camelCase: `status`, `preview`, `updatedAt`…). shell-list's `Session` is that summary, but it read the raw row, so the status, the preview and the time were missing ("Done" where the task said "Failed").
   - `model/wire.ts` `flatSession()` flattens body, then the columns (camelCased), then the summary. It keeps one flat row per server row while the row is unchanged, so memoised sections and keyed rows stay put.
   - It's used by the model's `rows` and `row()` and by the group rows.
   - Test: `plugins/shell-list/ui/test/wire.test.ts` "a server session row reads with its summary".
2. **Sections opened by default started folded.** `isOpenSection` was inverted. On a phone, "Needs you" showed folded with its task hidden; on desktop the open task's row stayed only because a folded section keeps the open row.
   - Test: `plugins/shell-list/ui/test/flat.test.ts` "Needs you and Working start open, Done and Archived folded, and a toggle flips each".
3. **The row squeezed its title** to "a…" in the 340 px sidebar. The kit's `ListRow` gets `layout="feed"`, v1's task row (#feed .it-head): the time and the actions on the title's line, the pills on the line under it, beside the preview. shell-list's task row uses it, and other lists keep the one-line layout.
   - The row's quick buttons are v1's 24 px, pulled in by their margins (`control-xs`); a gap holding a button's place is the same size.
   - The title went from 28 px to 126 px wide.

## Left (next in item 7)

- **The title is still cut** ("add a greeting to …") at 1440. The row reserves 68 px for three hidden quick buttons (save, done, more). v1 reserved about 40 px for two, with no More. Decide whether More stays in the row or only in the context menu, as v1 had it.
- **The time reads "45m ago"** where v1 showed "1m". design/copy.md says lists use "28m ago", so I kept the kit's form. A question for the owner.
- shell-task's real screens, so its extensions can attach. Then shell-home's Home screen and shell-composer's screen. Then the 46 views at v1 parity, the new screens, and the composer's `@` and `/`.

## Round 3 (2026-11-10)

Seen on a real `wisp serve`, with the fake claude linked as `claude`:
- `docs/qa/round7-list-1440-dark.png`
- `docs/qa/round7-goal-1440-dark.png`
- `docs/qa/round7-goal-390-light.png`

1. **More moves to the row's context menu** (owner, v1 parity). The row keeps two quick buttons, about 46 px. The title went from 126 px to 148 px wide, and "add a greeting to a.txt" fits whole.
2. **wisp.goal's band, wired end to end:**
   - **Server:** the goal plugin contributes `runtime.summary@1`, so a task's list row carries `summary.goal`, the GUI's `GoalView`: the text, judges, vote, status (`working`, `checking`, `met`, or `out` once stalled), round, `setAt`, the last round's checks, and `last` with its tally. Test: `goal_summary_shows_where_the_goal_stands`.
   - **The frame:** its task view renders `shell.task:band` over the turns.
   - **The plugin:** `wisp.goal.band` attaches there. goal's `useTask` reads the row's `summary` as its own fields.
   - Test: `apps/web/test/plugins.test.tsx` checks the band has a plugin.
3. **The kit's buttons are never wider than their box.** A long label ends in `…`, so the goal band's check line no longer runs under "Resume goal" on a phone.
4. **A waiting task's header said "Finished".**
   - `statusOf` now says Waiting when the task's state is `waiting` (an ask, a stalled goal), whatever its last turn said. Test: `packages/shell/test/rows-view.test.ts`.
   - The shell's `SessionState` type lacked `waiting`, which the Rust enum has; that's how this went unseen. Fixed.
5. **The demo's "Claude Code failed / exited with code 0"** was my setup, not wisp: the fake agent plays the CLI its file name names, and I had pointed `WISP_CLAUDE_BIN` at `wisp-fake-agent` itself. Link it as `claude` and runs finish. Seen: three goal rounds, then a question.

## Left (next in item 7)

- **Built but unattached plugin UIs:**
  - router (8 components);
  - ship (6, no `index.ts`);
  - worktrees (4);
  - update (1);
  - goal's other three: Checks, EditGoal, RunView, which are views.
  - Each needs its area and its server data checked the way the band's were.
- **Stubs:** shell-task's screens (they render nothing), shell-home (models only), shell-composer (parts only). Then the remaining v1 views at parity.

## Round 4 (2026-11-10)

Seen on a real `wisp serve` (fake claude linked as `claude`):
- `docs/qa/r8-changes-1440-dark.png`
- `docs/qa/r8-changes-1440-light.png`
- `docs/qa/r8-task-390-dark.png`
- `docs/qa/r8-task-390-light.png`

1. **List times are v1's** (owner: v2 looks exactly like v1, ADR-0016):
   - now, then 28m, 4h, 3d, each unit rounded, days with no end, as v1 `format.js` `ago()`;
   - the kit's `time.*` strings and `timeLabel()` changed, and design/copy.md now says the same.
   - Test: `packages/ui/test/content.test.tsx` "the past is relative, short, as v1 wrote it".
2. **The Changes pane, the first real shell-task screen:**
   - **The frame:** the kit's `Stage` takes a `side` region, v1's `#panel`: a full-height column at the right, `--size-panel-w` 480 px (a new token, `tokens.css` regenerated). The frame mounts its `SidePane` there. It rendered nowhere before, so every side pane was unreachable.
   - **shell-task:** `shell-task.side.changes` attaches to `shell.side:changes`:
     - every file the task changed, with its diff, through the kit's `Diff`;
     - read from the turns, where runtime keeps changes (`body.ext["wisp.runtime"].changes`);
     - paths relative to the task's folder, `/private/tmp` included on macOS.
     - Test: `plugins/shell-task/ui/test/changes.test.ts`.
   - **The frame's turn stats** read the same place, so "1 file +1 −1" shows and opens the pane. It read `body.changes` before, which is always empty.
3. **`goal.set` on the server:** wisp.goal's command `goal.set {id, text}` sets, changes (the count starts again) or clears a task's goal.
   - It's stored in `ext["wisp.goal"]` (`GoalState.text`, or `state: cleared`) and read over the spec's goal by the summary and the judging.
   - It's in the manifest, granted by the user set's `goal:*`, and an MCP tool like any listed command.
   - Test: `goal_set_changes_or_clears_the_goal`.
   - Seen: set, then cleared on the real server; the list row's `summary.goal` followed.
   - The frame's optimistic patch now says `working` (it said `running`, not a goal status) and clears the goal for empty text.

## Round 5 (2026-11-10)

Seen on a real `wisp serve` (fake claude linked as `claude`, the demo project committed so git has a base):
- the side pane: `docs/qa/r9-changes-1440-{dark,light}.png` and `docs/qa/r9-changes-390-{dark,light}.png`;
- the task page with its question: `docs/qa/r9-ask-1440-{dark,light}.png` and `docs/qa/r9-ask-390-{dark,light}.png`.

1. **The side pane, as v1's `#panel`:**
   - **Its head:** Changes · PR · Shell tabs (the kit's `Tabs`) and close. shell-task attaches the panel to all three side areas, so switching keeps the head.
   - **PR and Shell aren't built:** they say "Not in this pane yet". They're not counted as done.
   - **Changes from git:**
     - wisp-git's `git.changes {path, base}` gives every file the work changed since it left its base, committed or not;
     - the base is the task's worktree base (`ext["wisp.worktrees"].baseRef`), else HEAD;
     - rows with context and line numbers, a new hunk after each gap, "1 file · +1 −1 vs HEAD".
     - A folder that isn't a repo falls back to the turns' own edits.
     - Test: `changes.test.ts` "git's diff against the base reads as the kit's".
   - **On a phone:** the pane covers the task as its own page (the kit's Stage renders `side` in stack layout too, `--z-pane`, a new token).
2. **The task page's turns, from real data:**
   - the read/edit/run counts and the activity list read the turn's `event` rows (they read `body.activity`, which the server never sends, so they were always 0), with paths shown from the task's folder;
   - each answer shows its whole presentation through the kit's `Answer`. `TurnView` takes an `answer` slot, in the hero's place.
3. **What waits on you, over the reply box:**
   - a new input `shell.task:foot` (additive, contract.ts);
   - shell-task's `TaskFoot` shows the agent's live question with its choices, or a tool's Allow / Always allow / Deny (`runtime.answer`; the card goes at once, and a refusal brings it back);
   - then the queued follow-ups, with Send now (`runtime.queue.sendNow`) and Remove (`runtime.queue.edit`, at once).
   - Test: `foot.test.ts`. `apps/web/test/plugins.test.tsx` now checks that `shell.task:foot` and `shell.side:changes` have their plugins.
   - **Seen:** the stalled goal's question, on the real server. The queue isn't seen: the fake finishes too fast to queue behind.
4. **"Take over" is "Open in <harness>" everywhere** (the queue's rename):
   - the task's action and its More entry: "Open in Claude Code", from the task's harness;
   - i18n keys `shell.task.openIn` and `openInTitle`, and `shell-settings.keys.openIn`; Settings' "Open tasks in";
   - the QA notes (qa/views.mjs, qa/scenarios/web.md) say it too;
   - **TUI:**
     - `o` hands the terminal to `wisp open <task>` (the CLI's Open-in, v1's Take over) and takes it back after;
     - Space opens a step; the help and the goldens say so;
     - `handed()` is the one way the TUI hands the terminal over, shared with `$EDITOR`.
     - Test: `o_opens_the_task_in_its_harness_and_space_opens_a_step`.
5. **shell-task's main screen** stays the frame's view, with shell-task's parts attached: the band, the foot and the side pane.
   - Moving the frame's TaskView into the plugin would copy its helpers (rows-view, commands, harness, pickers), which the frame's Home and sidebar share.
   - The stubs left: TaskHead, Transcript, PlanView, the cards other than the question, and SidePanel's PR and Shell.

## Round 6 (2026-11-10): step 4 and Settings

Seen on a real `wisp serve`:
- Settings → Auto at 1440 and 390, dark and light: `docs/qa/r10-auto-*.png`;
- Worktrees and Updates at 1440: `docs/qa/r10-worktrees-1440-*.png`, `docs/qa/r10-updates-1440-*.png`.

1. **Settings never opened in v2.**
   - **No registration:** `shellSettingsUi(...)` has no default export and nothing called it, so the Settings frame wasn't registered. Every pane (General, Notifications, Keys, Auto, Worktrees, Updates, This Mac) was unreachable.
     - `apps/web/src/main.tsx` now registers it after the glob, with every plugin's panes, each with its plugin's client (`Shell.settingsPanes()`, additive), and the translator.
   - **Its view id:** `shell.settings` was outside its plugin's namespace, so registering it threw and the page didn't boot. It's now `shell-settings.sheet`, and the frame's Home and sidebar and wisp.machine open it by that.
   - **v1's one wide surface:** the panes listed on the left, the pane on the right. It opens as a `viewer` (a large dialog; a sheet on phones).
     - Kit: `Dialog` and `Sheet` take `bare` (the content brings its own head and close; the title stays for screen readers).
     - Contract: `ViewDef.bare` (additive); the Settings view sets it.
2. **router:** its Settings → Auto pane is registered (agents group). The scaffold's probe stays detached.
3. **worktrees and update:** their panes were already declared; with Settings registered they show, and they read the server (seen).
4. **ship, wired:**
   - **The plugin entry:** the PR pill on a task's row (`shell.row:head`), the PR strip over the open task (`shell.task:band`), and Ship it's dialog as an overlay view (`ship.dialog`; the plugin test caught `wisp.ship.ship` outside its namespace).
   - **The frame's "Ship it…"** opens that dialog; it called `ship.open`, which no server has.
   - **The command args:** wisp-ship's commands name the task by `session` (the bare id). `@wisp/client`'s `defineCommand` takes `wire`, the args as the peer's command takes them (additive), and ship's seven commands use it.
     - Test: `packages/client/test/commands.test.ts` "a command's wire shape".
   - **Ids aligned with the server:** `ship.prepare` → `ship.view`, `ship.fixConflicts` → `ship.fix_conflicts`, `ship.checkLog` → `ship.check_log`. The last two are now listed in ship's manifest; they were registered but unlisted, so default deny made them unreachable.
   - ship's `shell.ts` uses @wisp/shell's context.
   - **Not seen:** the pill, the strip and the dialog with a PR. That needs a pushed branch and gh; the fake setup has neither.

## Left (next in item 7, in this order)

- **Server handlers missing for UI commands:**
  - ship's `ship.review` (review by another harness);
  - router's `project.update`;
  - "Harnesses it may use" is empty: the `harness` rows the Auto pane reads don't come from the server;
  - Worktrees' On disk list stays at "Looking…".
- **The task page:** the PR and Shell side panes, TaskHead, transcript folds and PlanView, so shell-task has no stubs left.
- **Step 5, the v1 panes and views still missing:** Agents, Connectors, Machines, Cloud, Memory, Automations, Spells, Usage, Privacy; then crew, My Stuff, the computer pane, automations and machines as screens.
- **Step 6:** the new screens.
- **After the GUI:** the channels grammar port.

## Round 7 (2026-11-10): the sweep, and server data the UI waits on

### The sweep (owner: "Settings had never opened, so others may be in the same state")

- **Commands:** `/tmp/sweep.py` compares every UI `defineCommand` id (packages/*, plugins/*/ui) with every command a server manifest lists, or that the kernel and the binary define.
  - 124 UI commands; **59 have no server**. The full list is in `docs/v2-sweep-commands.md` (generated; regenerate it after fixes).
  - Groups: the frame's own (`runtime.setMode`, `runtime.setAgent`, `runtime.forLater`, `checkpoint.restore`), shell-task's `session.*` (v1 names), shell-composer's `runtime.reply`, `runtime.side` and `runtime.queue.now` / `cancel`, goal's pause / resume / drop / check, connectors (5; its host lists no commands), stuff's publish / unpublish / targets / starters and `share.*`, worktrees' keep / dismiss / bringIn, machine's four, crew's export / import / localKit, `later.park`, `project.update`, `ship.review`.
  - Many are renames to commands the server has, under v1's names. Some are real gaps.
- **Plugin UIs registered nowhere:**
  - fixed: Settings (round 6), shell-list (round 1), ship (round 6);
  - still unregistered: connectors and stuff (built components, no `index.ts`); shell-composer and shell-home (parts and models only).
- **Topics the UI watches that no server writes:**
  - fixed: Auto's `router_view` (below);
  - still open: worktrees' `plugin:wisp.worktrees:worktrees` (`worktrees.item`, `.leftover`, `.status`, `.offer`). The server publishes no rows, so Settings → Worktrees' On disk list stays at "Looking…".

### Fixed this round

- **Settings → Auto's view:**
  - **Cause:** the pane watched `plugin:wisp.router:view` for a `router_view` row, and no server wrote one, so "Harnesses it may use" and What it learned stayed empty.
  - **Fix:** wisp-router publishes `router.view`'s answer as that row:
    - flat, so the UI reads `arms`, `goal` and `settings` at the top and its optimistic patches still apply;
    - a forward-only migration 2, `router_view`;
    - written at start and after every view, set and reset.
  - Test: `the_auto_view_is_published_as_a_flat_row`. Clippy is clean on wisp-router.

### Left (next, in this order)

1. **Server data the UI waits on:**
   - worktrees' rows (a table per kind, written on each sweep and status);
   - `ship.review`;
   - `project.update`;
   - then the 59 commands in `docs/v2-sweep-commands.md`: the renames on the UI side (`wire` makes the arg shapes match), the real gaps as server handlers, each with a named test.
2. **Register** connectors and stuff, each checked on the real server.
3. **The task page:** the PR and Shell side panes, the head, transcript folds, the plan view.
4. **Step 5:** the missing v1 Settings panes, then crew, My Stuff, the computer pane, automations, machines.
5. **Step 6:** the new screens.

## Round 8 (2026-11-10): the `ui-commands` rule

- **`tools/check/rules/ui-commands.ts`**, in `RULES`, errors only:
  - every command id a UI package defines (`defineCommand`) is listed by a plugin manifest, and named in that plugin's Rust;
  - every `plugin:<id>:<name>` topic a UI watches is named in some plugin's Rust (a writer);
  - every `plugins/*/ui` is registered by apps/web: a default export from `src/index.ts`, or an import in apps/web/src.
  - Fixture test: `tools/check/test/ui-commands.test.ts`. It passes, with four kinds of finding, one each.
- **Baseline on the repo: 79 findings,** listed in `docs/v2-sweep-commands.md` (regenerated from the rule). It's more than the sweep's 59 because the rule also checks the Rust side and the topics:
  - 61 commands with no server (the shell-task, crew and later `session.*`, the frame's 4, shell-composer's 5, connectors 7, crew 4, goal 4, machine 4, stuff 6, share 3, worktrees 3, `ship.review`, `project.update`);
  - 3 topics nobody writes: `plugin:wisp.machine:snapshot` and `:load`, and `plugin:wisp.worktrees:worktrees`;
  - 14 plugin UIs registered nowhere: accounts, automations, budget, connectors, grid-client, issues, learn, machines, plugins, settings, shell-composer, shell-home, stuff, telemetry.
- **⚠ The rule fails `npm run check` (and CI) until the 79 are fixed.** That's the point, but it means CI goes red as soon as this lands. Fixing them is the next job, in this order:
  1. the renames to the server's ids (`wire` reshapes the args);
  2. the server handlers, each with its named test;
  3. the topics;
  4. the registrations.

## Round 9 (2026-11-10): ui-commands, step 1 (renames), 79 → 62

Renamed to the server's ids. The args are reshaped by `wire`; the server's catalogue is the source of truth:
- **shell-task:**
  - `session.rename / stop / reply / answer / allowRetry / markDone / reopen / archive / fork / rerun / compact / held` → `runtime.rename / stop / followUp / answer / approveBlocked / setState (done, review) / archive / fork / rerun / compact / release`;
  - answer sends allow / always / deny or the choice as `text`;
  - held: cancel → skip, the rest → start. Wait sends nothing; it's what not answering does.
- **crew:** `session.answer / followUp / update` → `runtime.answer / followUp / markRead`.
- **shell-composer:**
  - `runtime.reply` → `runtime.followUp`;
  - the queue's edit → `runtime.queue.text` (one item's text);
  - `queue.now` → `runtime.queue.sendNow`;
  - merge and stop wired to the server's args (`ids`, `id`). Merge and stop had the right ids but the wrong args, which the rule can't see.

Typecheck is clean for shell-task, crew and shell-composer. Not seen in Chrome this round; the next round checks these with the step-2 handlers.

**Left: 62,** listed in `docs/v2-sweep-commands.md`.
- **Step 2, server handlers:**
  - the frame's `runtime.setMode`, `runtime.setAgent`, `runtime.forLater` and `checkpoint.restore`;
  - `session.setMode / exec / appState`, `runtime.side`, `runtime.queue.order / cancel`;
  - later's `session.held` (needs the held turn's id on the row);
  - goal 4, machine 4, worktrees 3, crew 4, connectors 7, stuff 6 (publish needs the grid flow; `stuff.setPublished` takes the published link), share 3;
  - `ship.review`, `project.update`.
- **Step 3, topics:** the machine snapshot and load; the worktrees rows.
- **Step 4:** the 14 plugin UIs registered nowhere.

## Round 10 (2026-11-10): ui-commands, steps 2–4, 50 → 13

Every command a UI sends now has a server handler, and every topic a UI watches has a writer. The 13 left are
plugin UI packages with logic but no screen (below). Clippy is clean on the 19 touched crates.

### Server handlers (each with its named test)

| UI sent | Server now | Named test |
|---|---|---|
| runtime setMode / setAgent / forLater / queue.order / queue.cancel / held | `runtime.*` (ops.rs, more.rs) | `mode_agent_for_later_and_queue_order_and_cancel_change_the_task`, `the_row_carries_for_later_and_the_held_turns_id` |
| goal pause / resume / drop / check / set | `goal.*` | `goal_pause_resume_and_drop_move_its_state`, `goal_set_changes_or_clears_the_goal` |
| worktrees keep / bringIn / dismiss | `worktrees.*` (+ Bring in offers, core `offer.rs`) | `keep_pins_a_tasks_worktree_and_an_unknown_task_is_not_found`, `bring_in_makes_tasks_of_the_offers_paths_and_not_now_is_remembered`, `a_projects_foreign_worktrees_are_offered_once_and_wisps_own_are_not`, `bring_in_takes_only_the_offers_paths` |
| machine stop / fix / harnessClean / pauseAutomations, `machine.read` | `machine.stop`, `.fix`, `.harness.clean`, `.automations.pause`, `.read` (procs.rs: ps, attribution, leftovers, history) | `stop_refuses_wisp_its_parents_and_strangers`, `a_running_tasks_run_is_the_tagged_process_wisp_started` |
| crew localKit / export / import | `crew.kit`, `crew.export`, `crew.import` (transfer.rs) | `a_crew_bundle_exports_reviews_and_imports_paused_and_a_secret_refuses_it` |
| later.park | `later.park` (→ runtime.forLater, setState for Undo) | `park_saves_now_or_at_the_old_time_and_false_unsaves` |
| ship.review | renamed to `review.maybe` (force) | (wisp.review's own tests) |
| project.update | `runtime.projectTest` (a project's `test`), router lists projects | `a_projects_test_command_is_set_cleared_and_read_back`, `tests_per_project_lists_the_declared_projects_and_their_test_commands` |
| session.exec / session.appState | `runtime.exec`, `runtime.appState` | `an_app_blocks_state_is_kept_on_its_turn_and_exec_needs_a_command` |
| checkpoint.restore | `git.restoreTurn`; git keeps a checkpoint as each turn starts (`RunPart::before_turn`, additive) and `Repo::restore` (additive, `git:restore`) | `restore_puts_the_folder_and_the_branch_back_at_a_checkpoint` (real git), `a_turn_keeps_what_run_parts_give_it_before_it_runs`, `a_turns_checkpoint_is_read_from_its_ext` |
| share create / stop / peek (+ preview wire) | `share.create` (→ share.send to wisp Cloud, link kept on the task, `shared` on the row), `share.stop` (→ grid-client.revoke), `share.peek` (→ grid-client.fetch) | `a_share_link_is_kept_on_its_task_and_a_pasted_one_reads_as_its_card` |
| stuff starters / addStarter / reveal / targets / publish / unpublish | `stuff.*` commands (were HTTP-only or missing) | `show_in_folder_opens_each_oss_file_manager_on_the_item` |
| connectors add / update / remove / test / import / signin / signout | connectors host was a placeholder: pane.rs ports Settings → Connectors (secrets in the secrets file, local probe over stdio, remote over HTTP, harness configs found and imported, OAuth discovery + registration + PKCE + callback, bearer token to runs) | `a_connector_form_keeps_secrets_out_of_its_spec`, `the_connectors_pane_rows_carry_key_names_never_values` |

### Topics now written

- `plugin:wisp.worktrees:worktrees`: `worktrees.item`, `.leftover`, `.status` (`status`), `.offer` rows, republished when a look ends or a clean-up moves (`the_worktrees_pane_rows_are_published_flat_and_a_gone_folder_leaves`).
- `plugin:wisp.machine:snapshot` / `:load`: `machine.snapshot` and `machine.load` rows, id `this` (`the_snapshot_and_load_rows_are_published_on_the_topics_the_ui_watches`).
- `plugin:wisp.connectors:list`: `connectors.connector`, `.found`, `.reach`.

Two-word fields are snake-case columns (the store refuses camelCase column names): the UIs read `used_at`, `clean_at`,
`leftover_groups`, `mem_free_pct`, `paused_until`, `left_behind`, `signed_in`, `added_at`.

### v1 bugs found on the way

- Every Later command (add, edit, snooze, cancel, plan edit/start/cancel) sent the entity key `<peer>:<id>` where the
  server reads the bare id: each now has a `wire` that strips it.
- `share.preview` sent `{session}`; the server reads `{id}`.

### Screens

- **Settings → Connectors** (registered): the found banner (Not now / Review), your connectors with their check
  (tools, or why), switch and menu (Check again, Edit, Sign in/out, Remove), starting points when empty, the reach
  note, the Add/Edit form (local or remote, secret pairs, pasted config) and the import review. Seen working against
  the real backend: it found posthog and unstyle in this computer's harness configs, imported both, started unstyle
  and listed its tool, got PostHog's 401 and offered Sign in, and sign-in registered with PostHog's OAuth.
  PNGs: /tmp/wisp-qa-gui/r11-connectors-1440-{dark,light}.png, r11-connectors-390-{dark,light}.png,
  r11-connectors-review-1440-dark.png, r11-connectors-add-1440-light.png, r11-connectors-rows-1440-dark.png,
  r11-connectors-signin-1440-dark.png.

### Left: the 13 packages with no screen (none deleted: each is a v1 screen's home)

| Package | Its screen (v1 reference) | Backend |
|---|---|---|
| accounts-ui | Settings → Agents (`settings.agents`) | commands exist; rows are `body` docs, no `accounts.harness` rows yet |
| machines-ui | Settings → Machines | commands exist |
| grid-client-ui | Settings → Cloud | commands exist |
| learn-ui | Settings → Memory | **no commands** |
| automations-ui | Settings → Automations | commands exist |
| plugins-ui | Settings → Spells | 2 of v1's 10 |
| budget-ui | Settings → Usage | commands exist |
| telemetry-ui | Settings → Privacy | commands exist |
| settings-ui | (General is shell-settings'; this package is an empty scaffold) | settings.* |
| stuff-ui | My Stuff page, share dialog/card | commands exist |
| shell-home-ui | Home (needs, tips, overlaps) | — |
| shell-composer-ui | the task composer's queue and runner pickers | — |
| issues-ui | dev harness only, no src | issues.list |

Parity note for the shell: v1's Settings nav is flat (no AGENTS / COMPUTERS / ADVANCED headings) and the sheet is
wider (900 px from x 270); v2's frame differs.

## Round 11 (2026-11-10): the 14 unregistered UIs, 13 → 2

Every plugin UI package but two is registered with a real screen, seen in Chrome against the running binary.
None was deleted. `coder` owns the UI now (docs/v2-queue.md, two coders); `backend-coder` edits runtime and
update in the same worktree, so the server-side work below is only what a screen needed.

### Screens (named tests; PNGs in /tmp/wisp-qa-gui/r11-*)

| Package | Screen | Server side it needed | Named tests |
|---|---|---|---|
| connectors-ui | Settings → Connectors (round 10) | pane.rs (round 10) | (round 10) |
| accounts-ui | Settings → Agents: harnesses with version, models, state; extra accounts; CLI sign-in steps; opencode keys; Install; Re-check; changed-harness notice; git and gh; Ask when a harness changes | `accounts.harness/.account/.login/.key/.tool/.place` rows (view.rs), each CLI's status asked at start and after a change | `the_agents_pane_rows_are_flat_and_named_as_the_ui_reads_them` |
| telemetry-ui | Settings → Privacy: usage stats (and why off), repo-trust question | `telemetry.state` row | `the_privacy_row_says_on_off_and_blocked_by_the_environment` |
| budget-ui | Settings → Usage: 7-day spend, turns, worked, questions; plan windows; Automations stop at, per harness | `runtime.usage` (core usage.rs) | `usage_sums_spend_counts_turns_and_says_how_many_worked` |
| grid-client-ui | Settings → Cloud: sign in (device code), this computer on the grid, sign out | `grid-client.cloud` row, rewritten on every step | `the_cloud_row_carries_the_sign_in_under_way_and_who_is_signed_in` |
| machines-ui | Settings → Machines: machines over SSH (state, connect, remove, add), This computer over SSH | none (rows and `machines.reachable` exist) | — |
| automations-ui | Settings → Automations: recipes (run, remove), triggers (state, runs, run now) | none | — |
| plugins-ui | Settings → Plugins (v1's Spells, ADR-0031): every plugin, its state and switch | none | — |
| settings-ui | Settings → All settings: every declared setting, searchable, control by type, lock shown | none | — |
| stuff-ui | My Stuff page (sidebar): search, kinds, by day, cards and their menu, Add files | `stuff.item` view rows, rewritten after every command and upload | `my_stuffs_rows_are_the_view_flat_and_named_as_the_page_reads_them` |
| shell-home-ui | the finish/ask notifier (toast; system notification when wisp isn't in front), started by apps/web | none | `a_task_that_finishes_or_asks_tells_you_once_from_the_stores_row_shape` (vitest) |
| shell-composer-ui | the queued follow-ups over the reply box (`shell.task:foot`): send now, edit, combine, move, cancel (shell-task's minimal copy removed) | optimistic paths moved to `/body/queue` | — |

### Found and fixed on the way

- **The store takes camelCase column names** (quoted in every statement; a case-only twin is refused), so a
  plugin's rows reach the UI as its types name them. `camel_case_columns_keep_the_wire_names_and_a_case_twin_is_refused`.
- **Ship it never loaded**: its manifest listed `ship.fix_conflicts` and `ship.check_log` twice and the kernel
  refused the plugin at start. `every_built_in_plugins_manifest_validates` (wisp bin; `PluginGroup::manifests()`).
- **Deep links to plugin views 404'd**: the edge took `/view/stuff.page` for a missing file. App routes are the app.
  Added to `bullet6_static_files`.
- A plugin's strings must sit under its namespace (`telemetry.*`, `budget.*`): registration threw silently otherwise.

### Left

- **learn-ui, issues-ui: blocked on backend** (backend-coder's v1-coverage gaps): learn's host is a placeholder
  (no commands, no retros), and `issues.list` can't resolve a project (nothing contributes `issues.projects`).
  Their screens: Settings → Memory, and the launcher's Issue picker (`design/v1-reference/home.issues`).
- Clippy on `wisp-runtime` and `wisp` is left to the batched pass: `more()` in runtime/plugin.rs is 103 lines
  after backend-coder's in-progress Cold/Exec edits, and the update plugin doesn't compile mid-edit.
- Missing in v2, seen while building these panes: v1's "Hide .env values", "Subagents run on", "Webhook triggers",
  the usage charts page, Cast a spell, harness logos in the kit. Not shown as switches that do nothing.
- The queue over the reply box was typechecked and wired, not yet seen with a real queue (needs a running task
  with follow-ups queued).
- Shell parity: v1's Settings nav is flat and the sheet wider; v2's Stats tiles put the value above the label.

## Round 12 (2026-11-11): the task page, answer blocks, the plan page

**Fixed first (the UI part of `npm run check`):** `answer-content.css` (76px → `--size-tests-ring`, a new token in
`packages/tokens/tokens/size.json`, generated files rebuilt; `flex-wrap` → the kit's `Wrap`), `app-task.css:108` (a step
with output is a column, `li[data-fold]`), `composites.css:38` (the `:is()` list split in two selectors),
`Connectors.tsx:72` (the page's origin comes from the shell's `Platform.origin`, new and additive, and the sign-in opens
through `platform.openExternal`), `StuffPage.tsx:82` (the upload goes through `client.http(peer).send`). The check's UI
errors are now only learn-ui and issues-ui, which wait on backend-coder.

**`@wisp/client`: a peer's own routes.** `Transport.request?` (a raw body) and `Transport.events?` (an event-stream
route), HTTP implements both with the peer's headers; `Peers.http(peer)` and `PluginClient.http(peer)` wrap them (JSON
answers, a status ≥ 400 throws with the server's words). Additive. Users: My Stuff's Add files, the Shell pane, and
drop/paste files next. Test `http_routes_carry_raw_bodies_with_the_peers_headers_and_stream_a_routes_events`.

**The task page.**
- Turn cards on a new slot `shell.turn:foot` (contract.ts, additive), shell-task's `TurnFoot`: HaltCard (signed out →
  Sign in; a usage limit → Send again / Hand to; a refusal → Hand to a harness on another vendor's model, v1 vendors.js
  ported as `cards/vendors.ts`), HeldCard (Start now / Skip, `runtime.release`), WhatChanged (the runtime now keeps
  `ext["wisp.runtime"].cli` per turn), Receipt (v1 receipt.js: cache share from the per-model counts, the longest plan
  window from `ext["wisp.budget"].plan`, Past your plan). A plain failure gets no card: its answer says it (v1 too).
- Side panel: PR (`PrPane.tsx`, `ship.details`; asks only when the task row carries a PR) and Shell (`ShellPane.tsx`,
  the kit `<Terminal>`, input numbered from 0 as `wisp_terminal_core::order` expects).
- Answer blocks: 9 of the kit's 14 stub renderers built (compare, terminal, tests, task, stuff, question, blocked,
  actions, next) with v1's CSS on tokens (`answer-content.css`, `answer-rich.css`, both were empty). `BlockContext`
  gained `draft`, `deny`, and `run` may return its result (`RunResult`). The frame now passes a context
  (`frame/answer-ctx.ts`: reply, draft, `runtime.exec`, `runtime.approveBlocked`, open task / link / changes / My Stuff,
  live task and stuff rows; `latest` read live).
- shell-task has no stubs: the dead `TaskMain`, `TaskView`, `head/TaskHead`, `transcript/Transcript`, `plan/PlanView` and
  three empty catalogues are deleted (the frame's head renames in place, its transcript folds; v1's plan view is
  wisp.later's page, below).
- Fixed on the way: toasts half off-screen (Zag's inline inset beat the kit's `left: 50%`); every phone state pill green
  (specificity).

**The plan page (`later.plan`).** shell-list opened it but later-ui registered no view, and the list read entity kind
`plan` while wisp.later publishes `later_plan` (`{id, body}`) on `plugin:wisp.later:later`, which nobody watched: the
Scheduled and Drafts sections were always empty. shell-list now watches the topic and maps rows (`listPlan`); later-ui
has `PlanPage.tsx` (the task page's shape; TaskDetails gained `when`). Test `the_plan_page_says_when_it_starts…`.

**Tests run (named only):** rows-view `a_turns_time…`, runtime `a_turn_keeps_what_the_cli_was`, shell-task `cards`,
`pr`, `pr-pane`, `vendors`, ui `blocks-act` (2), client `http_routes…`, later `plan-page`. PNGs in /tmp/wisp-qa-gui
(r12-*), 1440 and 390, light and dark.

**Left:** the `app`, `doc`, `preview`, `map`, `graph` block renderers (stubs; pure halves exist); the runtime recording
`refusal` on a turn (backend-coder); Settings parity and the rest of the queue.

## Round 13 (2026-11-11): the last five answer blocks, Settings parity

**Answer blocks (the kit has no stub renderer left).** `Map.tsx`, `Doc.tsx`, `Preview.tsx`, `Graph.tsx`, `App.tsx` on
their existing pure halves (map-spec, rich-doc, rich-preview-spec, graph-layout, rich-app-doc), v1's CSS in
`answer-rich.css` (and the shared rb-out/rb-title/rb-cant/rb-caption, which Image and Video used unstyled). BlockContext
gained `revealFile`; the frame's `answerContext` now keeps an app's state through `runtime.appState` (400 ms after its
last save). Fixed on the way: an app frame born with an empty `srcdoc` stays empty in Chrome (the page is built before
the frame). Tokens: `size-map`, `size-preview`. Test `map_doc_preview_graph_and_app_blocks_render_and_act_as_v1s_did`;
the gallery's Rich blocks section shows all of them (PNGs r13-{map,preview,graph,app}-*).

**Settings parity** (the parity gate, one `settings.<pane>` view per run):
- The sheet: `Dialog size="xl"` (900 × 680, tokens `size-dialog-xl[-h]`), the frame is the card (its line and corners,
  `surface`), 200 px nav (172 under 800), 58 px head, v1's type (14 px, 1.55, ink). On a phone: a full-screen sheet
  (`Sheet size="xl"`), and the account menu opens Settings on its list as v1 did.
- The nav: one flat list in v1's order (`V1_ORDER`), v2's own panes after; tabs (`role="tab"`) as v1's tablist, which is
  also how the gate's v1 openers reach a pane.
- Rows: groups on `surface-2`, rows 9 × 14 px (11 on a phone), the line on top of the next row, wide selects stretched.
- Bugs fixed: picking a pane didn't reach the frame (the view copied `params` once); picking used kind `dialog`, so the
  sheet shrank to 600 px after the first click; General crashed in dev builds (a local component named `Switch` was
  taken for Solid's); Take over in never showed (no `terminal.app` rows exist: it asks `terminal.apps` now, listed in
  wisp.terminal's manifest as ui-only).
- Missing v1 settings built: Hide .env values (`git.maskEnvFiles`), Webhook triggers (`automations.webhookTriggers`, the
  Automations pane rebuilt as v1's one group with Manage), Subagents run on (`runtime.subagentModel`), the Usage tiles
  (`Stats compact`), harness logos (`SettingsRow logo`, and ui packages for opencode, Cursor, Antigravity, Grok and
  Copilot carrying v1's marks, mono ones following the OS scheme).
- Results: settings.general at 1440 light/dark: every settings part matches v1's metrics; the pixels left (2.7% / 4.5%)
  are the home page under the sheet (v1's New task button, its card shapes). Ten panes reach and compare; Memory
  waits on learn (backend-coder), Spells is v2's Plugins (ADR-0031, a different pane id).
- Tests: `settings_nav_is_v1s_flat_list_in_v1s_order_with_v2s_own_panes_after`,
  `automations_lines_say_none_yet_or_name_what_there_is_as_v1_did`, the five harness ui tests, kit `settings.test.tsx`.

**Left for backend-coder:** a per-day usage command (Usage → Charts and breakdowns, Crew track record); `refusal` on turns.

**Keys, the @ and / menus, files (round 13, part 2).**
- v1's keys (about 30): J/K, O/Enter, E, A, L, M, Delete, T, Ctrl+`, P, D, V, ⇧R, ⇧F, S, C, U, ], /, 1–9, as
  `ShortcutDef`s in `builtins.tsx`. The open task's own act through `frame/task-keys.ts`: a cancelable DOM event the
  page handles as its buttons do (no shared state), the list's on the picked row. Test
  `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`.
- Fixed on the way: opening the side panel rebuilt the whole task page (App passed `side` as a reactive spread, which
  re-created `main`; and MainPane's keyed child read `nav()` tracked): the steps closed, the scroll and focus went.
- The @ and / menus: a new contribution, `PluginUiDef.prompt` (`PromptSourceDef`, additive, contract.ts), collected
  like the palette's; the frame draws them in the reply box and New task (`frame/prompt-menu.ts`, kit
  `PromptSuggestList`), sends a picked `@Title` as `@[Title](scheme:id)`; shell-composer registers tasks, crew, My
  Stuff and v1's commands (`prompt.ts`, its slash words added to its catalogue; /spell not offered, ADR-0031).
- Files: picked, pasted or dropped (`frame/attach.ts`, kit `onFiles` / `onPaste` with a drop highlight), uploaded at
  once through `client.http(peer)`, the prompt carrying them (`runtime.followUp` / `runtime.create` `attachments`).
  Before this, picked files were shown as chips and dropped on send. Test
  `pasted_and_dropped_files_become_chips_and_go_up_to_the_tasks_computer_as_its_attachments`.

**Left in the queue:** the searchable harness · model picker (shell-composer's RunnerPicker needs a frame slot or a
port), ↑ history in New task, files in the @ menu (a file-index command), the backend notes (Learning pane,
autoOverride, the route card, the cold line and Compact), the crew tint (#768), learn-ui and issues-ui, the new
screens.

## Round 14 (2026-11-11): the model picker, the backend notes, the crew tint, the goal ask, learn-ui, issues-ui

**The harness · model picker.** `frame/RunnerPicker.tsx` (Dialog: one search, harnesses left, models right, the
model's thinking levels), opened from New task's harness · model button; `runner.ts` pure, test
`the_harness_model_picker_searches_every_harnesses_models_and_offers_the_picks_thinking_levels`. `runtime.agents`
takes ~7.5 s, so it loads when Home mounts. The reply box's picker and the harness logos in the list are left.

**Auto in the launcher.** `frame/auto.ts`: `router.preview` after a 300 ms pause (scope timer), the newest answer
wins; the runner chip shows the pick (harness · model · level) and why in its tooltip; New task sends `agent: 'auto'`
when Auto previewed (before this the frame sent the default harness, so the router never routed a New task), the
row showing the previewed harness until the peer's arrives (`shows`, not sent); `autoOverride {key, type}` when you
pick your own after a preview. Routed rows: the kit's `run.routed` (v1's accent dot) and v1's routeTip
(`ext["wisp.router"].route`, not once `switched`). Tests `picking_your_own_harness_after_autos_preview_tells_auto_what_it_had_shown`,
`a_routed_rows_logo_says_why_auto_picked_it_as_v1_did`.

**The cold line and Compact now.** `frame/cold.ts` over `runtime.cold` (asked when the task settles or changes);
the kit `ReplyBox.hint` (v1 .c-hint/.c-cold-row with the short form under 326 px: token `bp-bar-cold`); Compact now
in the ⋯ menu with its note while warm (`runtime.compact`, optimistic running). Test
`a_large_idle_tasks_cold_cache_and_compact_now_say_what_v1_said_and_when`. The Fable vendor mark was already in
`cards/vendors.ts`.

**Refusal and limit cards on the real fields.** `turn.refusal` and `turn.limit` (`cards/model.ts` haltOf); the limit
card's Wait until the reset (`later.add` CARRY_ON at `until`), "Carries on at …", the other harnesses, Get extra
usage; an unknown refusing vendor offers every other harness. Tests in `cards.test.ts`, `vendors.test.ts`.

**Drain watch, window notices, Lean runs.** Settings → Usage (`budget/ui/src/drain.ts`, test
`drain_watch_and_window_changes_say_what_v1_said`; `budget.dismissDrain`/`dismissNotice`); Settings → Agents Lean
runs (`runtime.leanRuns`); a Claude task's ⋯ Lean runs: follow / on / off (`runtime.setLean`).

**Settings → Memory (learn-ui).** `plugins/learn/ui`: Learn from tasks (`learn.enabled`), Remembered (count · last
retro), Open memory (each scope's preferences and lessons, remove and add through `learn.set`, the recent retros).
Test `the_memory_pane_counts_what_is_remembered_lists_scopes_and_edits_one_list`. Parity `settings.memory`: the pane
body matches v1; the diffs are the nav (v2's own panes) and seed data.

**Start from an issue (issues-ui).** `plugins/issues/ui`: an overlay view `issues.picker` from New task's Issue
button; `issues.list` for GitHub / Linear / Jira, filtered as you type and searched on the peer past the newest 50;
Other sources, or Connect Linear… / Jira… (Settings → Connectors with v1's Linear / Jira example filled in, or yours
to sign in again: connectors-ui `exampleFor`/`isFor`). Picking fills New task's prompt through a new additive
`ShellContext.prompts` (`provide`/`get`, optional; New task registers 'launcher'), with Undo for a replaced draft.
Test `the_issue_picker_lists_a_sources_issues_offers_the_others_or_connect_and_writes_the_prompt`.

**My Stuff Publish.** StuffPage's menu: Publish to `<grid>` (`stuff.targets`), Copy / Open public link, Update the
public link, Unpublish, with v1's toasts (Published at …, Link copied, Open).

**The crew tint (#768).** Kit `Stage.tint` (v1 .crew-tint: an 8% wash of `--pc` on the list and its top bar, split
with the rail); `frame/crew-tint.ts` (the member's glow: its spirit's colour, else its own); setting `crew.tint`
(declared in the crew manifest, bool, on) with Settings → General → Crew tint. Test
`a_picked_crew_member_tints_the_list_with_their_glow_unless_the_setting_or_their_tint_says_none`. The per-member
Task panel tint (`bg`) needs the field on the peer.

**The goal ask (#769).** `frame/goal-gate.ts`: Goal on and Done when empty stops Send in New task and the reply box,
puts the caret in Done when (kit goal line `ref`) and offers Send without a goal; a goal with no prompt says Say what
to do first. Test `send_with_goal_on_and_done_when_empty_asks_first_instead_of_starting_a_one_shot_task`.

**v1 bug found on the way.** Settings switches on settings their plugin declares `bool` (Accept tasks from
channels, wisp blocks, Auto-fix PR conflicts, Watch agents work, Interactive answers) wrote `'on'`/`'off'`, which the
kernel refuses ("must be true or false"): every click rolled back. `source.ts` `onOff(…, key)` writes true/false for
`BOOL_KEYS`. Test `a_switch_on_a_bool_setting_writes_true_or_false_not_v1s_on_and_off`.

**Not built:** the grid account page's routing form. The form's markup is in `apps/grid/src/pages/account.rs`, but
the v2 grid serves no signed-in pages (`/` is a message page; nothing calls `account_page`) and has no
`POST /channels/route` or `/channels/route/remove`; that is grid-edge work for backend-coder.

**Left:** the reply box's harness · model picker; logos in the picker's harness list; the per-member tint (`bg`);
the new screens (Repo tab, blame gutter, import, Share setup, Setup section, My shares, the Automations When picker,
crew Wakes).

**Found while checking in Chrome (round 14):** the rail read crew members as `crew.member` rows, but the crew host
writes `crew_member` (topic `crew`): the rail showed nobody on a real server (fixed in Sidebar, App's tint, the @
menu's crew source and the dev seed). The runtime's manifest listed `""` as an enum value (`runtime.subagentModel`),
which the kernel refuses, so `wisp serve` ran without runtime and every harness: values are now `task`, `haiku`,
`sonnet` (budget-ui writes `task`); `npm run check`'s manifests rule uses the TS validator and missed it. Settings
rows don't read back on a real server (`settings_value` vs `setting`): a backend note.


## Round 15 (2026-11-11): settings read back, the crew page, the grid's pages, the When picker, My shares

**Settings read back (one shape end to end).** The store published `settings_value` rows (`{id, body: {v}}`) that no
client read; every pane reads `setting` rows (`{key, value, locked_by}`), and the config snapshot already served the
core `setting` table, which nothing wrote. Now:
- `crates/wisp/src/settings_store.rs` writes the core `setting` rows: `value` (what's in force), `locked_by`, and a new
  `saved` column (the user's own value, kept under another plugin's lock; core migration 3). Its migration 2 moves
  `settings_value` into `setting` and drops it. At start, last run's locks are let go (their plugins lock again).
- The kernel tells the backend about locks (`SettingsBackend::lock`, additive with a default body; `Settings` keeps the
  backend from `load`), so a pinned setting shows its value and who holds it.
- Test `a_setting_written_reads_back_as_the_setting_row_clients_read_after_a_restart` (old table moved, write, reset,
  device setting not published, lock then restart). Seen in Chrome: Accept tasks from channels read back as stored
  across reloads, toggled both ways.
- Found on the way: `runtime.subagentModel` listed `""` as an enum value, which the kernel refuses, so `wisp serve`
  ran without runtime and every harness (values `task`, `haiku`, `sonnet` now). `npm run check`'s manifest rule uses
  the TS validator and doesn't catch it.

**Item 2:** `routeOf`/`routeTip` and their test were already in HEAD (be96270e); nothing to redo. Now exported from
`@wisp/shell` and used by shell-list's row (the list the app draws; round 14 only reached the shell's fallback list).

**The crew page.** Kit `CrewView`, `CrewJob`, `CrewQuiet`, `CrewEmpty`, `CrewFacts`, `CrewSideActions`, `CrewSection`,
`CrewText` (`packages/ui/src/crew/CrewView.tsx`, `css/crew-view.css`, v1 crew.css values; the details column from
860 px of the page's own width by container query). crew-ui's `CrewPage.tsx` on `shell.screen:crew`; `jobs.ts` reads a
job from runtime's real row (`body.ext["wisp.crew"]`; crew-ui's types were v1-shaped and found no jobs); crew-ui's
command wires fixed to the crew API (`crew.assign {id, prompt}`, `crew.checkin {id}`, the optimistic job row in
runtime's shape). `CrewExt.prompt` (additive) carries what a job was asked. The list beside it: shell-list filters by
the picked member (`setCrew`), "No tasks for X yet". The rail and the tint read `crew.member` while the host writes
`crew_member`: fixed (shell, the @ menu, the dev seed). Tests: `a_members_page_reads_its_jobs_…`,
`a_picked_crew_members_list_holds_only_their_jobs_…` (shell-list), `…only_the_tasks_that_are_their_jobs` (shell).
Seen in Chrome: 1440 light, 1024 dark (folded About), 390 dark; a job given from the box ran and showed.

**The reply box's picker and logos.** `RunnerPicker` in the reply box: the pick rides on the next follow-ups as `run`
(`runPick`, test). Harness logos in its list (kit `RadioOption.logo`).

**The grid's signed-in pages.** `apps/grid/src/edge_pages.rs`: `GET /` (home, or the public page signed out),
`/account`, `/go`, and every form under them (`/instance/stop`, `/computers/:id/remove`, `/sites/:key/remove`,
`/devices/:id/revoke`, `/identities/unlink`, `/channels/route`, `/channels/route/remove`, `/signout[?all=1]`,
`/account/delete`), CSRF from the session cookie, v1's flash lines. The Telegram routing form shows when the grid
routes. Tests `a_signed_in_person_sees_home_and_account_and_their_forms_work`,
`the_account_page_offers_the_telegram_routing_form_and_says_what_was_wrong` (`apps/grid/tests/pages.rs`).

**New screens (item 5, part).**
- Automations → Triggers → New trigger: the When picker over `automations.sources`, grouped by plugin (kit
  `SelectOption.group`), the source's schema fields, the prompt, `resources.apply`; Test on the last 5 events
  (`automations.trigger.test`). Test `the_when_picker_groups_sources_by_owner_…`. Seen in Chrome.
- My shares under Settings → Cloud (`grid-client.shares`/`revoke`). Test `my_shares_lists_what_i_shared_…`. Not seen in
  Chrome (needs a grid sign-in).
- Found on the way: every Menu and Select opened behind Settings and dialogs (positioner z 40 under overlays at 50):
  now `--z-overlay-menu`.

**Backend leftovers (item 6, part):** Settings → Usage: Ask near the limit, Wait for the reset, Check Codex while work
waits; New task pre-fills its team from `runtime.subagents` and sends it (`teamPrefill`, `teamRows`, test).

**Left:** the other new screens (Repo tab, blame gutter, import, Share setup, Setup section, crew Wakes), the crew
editor (Edit…, Wakes), and the backend leftovers: the plugins install path (ADR first), crew.reply, terminal tasks,
Discord's /wisp, one turn per Slack thread, a PR following its branch's task, email attachments, the serve_budget
e2e, `wisp sdk types`, v1 sync #771–#774. automations' own sources (schedule, once) declare no field schema, so the
editor shows no cron field for them.
