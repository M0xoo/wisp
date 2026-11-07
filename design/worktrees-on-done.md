# Done asks about the worktree

A finished task keeps its worktree: its checkout, `node_modules` and build output, often gigabytes.
So do its subagents with folders of their own, the crew jobs it delegated and the compare runs beside
it. Left alone they fill the disk (234 folders, 21 GB on one Mac). Marking a task done is the moment
the user knows they're finished with it, so that's when wisp asks.

Code: `web/js/features/done-folders.js` (the dialog), `server/services/done-folders.js` (what's
under a task, what's safe), `GET`/`POST /api/sessions/:id/folders`.

## What's under a task

The task's own worktree and its other folders (`also`), and, each once by path: its subagents
(`children`, `parentId`), the crew jobs it delegated (`turns[].delegations[].sessionId`), what ran
under those (four levels at most), and the compare runs of its group that are done too (*Mark every
run done*; a run still in review isn't asked about). Left out: a folder in use (running, asking,
queued, a shell or app open in it), one brought in from another tool (`foreign`), one already gone.
A subagent working in its lead's folder is the lead's row.

## The dialog

- Opens **on the click** when the task has a folder of its own (`branch` on its summary), with
  placeholder rows in the real shape; the rows replace them. A task whose folders are all under it
  asks once the list is in. Nothing on disk: no dialog.
- Title *Remove its worktree?* / *Remove its 3 worktrees?*. Under it: *Their branches stay, and a
  follow-up brings a folder back.*
- One row a folder: a checkbox, *This task* or the task's name, its branch, its state and its size.
  State, first that applies: *N uncommitted files* (warn colour), *Commits off its branch*, *Can’t read
  it*, *PR #N open*, *PR #N merged*, *N commits not pushed*, *Clean*. Sizes come in a second request
  (`du` takes seconds on a big folder): a placeholder until then, blank where there's no `du`.
- Clean rows are ticked. A row holding work (`only > 0`, or git can't tell) is **unticked** and says
  *3 uncommitted files will be lost*; ticking one turns Remove red.
- Footer: *Always do this* · **Keep** · **Remove** (primary; *Remove 3* when more than one is ticked;
  disabled with none ticked).
- **Remove** closes the dialog at once; the removal runs in the background and a toast says
  *Removed 3 folders · 4.2 GB*. One that can't go is kept (`keepWorktree`) and a red toast says why.
- **Keep** pins every row (`keepWorktree`), the same as the pin in Settings → Worktrees.
- Esc, × or a click outside answers nothing: the folders stay for the hourly cleanup.
- Phones (≤ 640px, the app too): a sheet from the bottom, the state under the name, Keep and Remove
  side by side, full width, 44px.

## The setting

`defaults.worktreeOnDone`: `ask` (default) · `remove` · `keep`. In Settings → Worktrees as *When a
task is done* (Ask / Remove clean ones / Keep them), in `SETTINGS` for spells and in `LOCKABLE`.
*Always do this* sets it from the dialog; it's hidden when a spell sets it.

- `remove`: the clean folders go with no dialog. Any holding work still get the dialog, titled *This
  worktree holds work*, with only those rows, unticked.
- `keep`: no dialog; every folder is pinned.

## Done from anywhere else

A channel, the phone's notification, `wisp_task done`, Ship it's merge, a spell hook
(`launcher.markDone`): **no dialog and no card**, ever. Only folders with nothing of their own
(`folderOnly === 0`), no open PR, not kept, not in For later and not in use go; the rest are left to
the cleanup. Nothing goes when the setting is `keep`.

A **crew job** (and what it delegated) that ends done or for review does the same, once its CLI has
let go (a few seconds). Quiet check-ins, archived as they end, already lost theirs.

The branch always stays, so commits are never lost, and replying to the task brings the folder back
(`ensureWorktree`).
