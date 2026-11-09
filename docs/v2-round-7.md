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
- **Commands with no server handler:** the GUI's `goal.set` command (frame `commands.ts`) has none. The goal is set through `runtime.create`'s `goal`, and nothing changes it after.
- **The time format:** "45m ago" (design/copy.md) against v1's "1m". The owner decides.
