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
