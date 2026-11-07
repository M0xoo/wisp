# The side panel: Changes, PR, Shell, Preview and Watch

A third column in split view, on the task's far side from the list, for doing things with what an
agent made without leaving wisp. It shows one thing at a time: **Changes**, every file the task
changed with its diff; **PR**, the task's pull request without the noise; **Shell**, a real shell in
the task's folder on whichever computer ran the task; **Preview**, the task's app run from its
worktree; **Watch**, the page its agent keeps (below).
Code and CSS call it the *side panel*. On screen it has no name of its own: its head is its tabs.

**Tabs inside the panel, doors on the task.** The task is still the main thing, and each view is
reached from the task (its buttons, its PR row, the menus, the keys). Once the panel is open its
head is a segmented switch, **Changes · PR #412 · Shell · Preview · Watch**, so you move between them without
going back to the task. The order is fixed; Watch, the only one that comes and goes (once there's a
page), is last so the others never move. No counts on the tabs: a number changing as you watch
would shift them.

- The switch is `.pn-tabs` (the preview block's `.pv-seg` look): 30px, `--bg-2`, 1px `--line`, 9px
  radius; the shown tab on `--surface` in `--accent-ink` with `--shadow-1`. `role=tablist`, each
  `role=tab` with `aria-selected`; ←/→ move to the next tab and show it. Under 420px of panel every
  tab is icon-only (32px, `title`) at once. On phones it fills the page's head after Back: text
  only, equal widths, 40px; switching swaps the page in place (no `stack-in`, no new Back entry).
- It opens on Changes until you've picked another (`wisp.panel`, `panel.tab`).

## Editing a file

Changes is also where you fix a line yourself (`editor.js`). Each file row has a pencil (*Edit
here*, also in its ⋯), except deleted and binary files. The editor covers the panel, head included
(its own 42px head: Back, the path in `--mono` cut at the start, *Saved / Unsaved / Saving…*, then
**Save**), so there's one thing on screen and Back is where the tabs were.

- **The head keeps its order of need.** Back never shrinks, the state is one short word, and the
  file name takes what's left. While the agent works the word stays *Unsaved* and why Save is off
  is the tip on both; touch has no tips, so there the word is *Agent working*. Under 540px of head
  the language offer is its spark alone, still named and with its tip.
- **The browser's own text box.** The code is highlighted (`highlight`, the diff's colours) in a
  `<pre>` under a transparent `<textarea>`: selection, IME, spellcheck off, undo and the caret are
  native. Line numbers sit in a sticky gutter. 12.5px mono at 1.6, like the diff.
- **Save is instant and safe.** ⌘S or Save says *Saved* at once and rolls back to *Unsaved* with a
  red toast if the server refuses. The server refuses while the agent works on the task, and when
  the file changed since it was opened (the hash it was read with): then a warn line offers
  **Load theirs** or **Keep mine**, never a silent overwrite.
- **Esc goes back to Changes**, asking (`ask`, by Back) when there's unsaved work. The editor
  belongs to its task: moving to another task hides it, and coming back shows it as you left it.
- **Any file, any line.** *Open file…* (Changes' summary, ⌘K *Open a file…*, ⌘P in the editor) is the
  palette over the folder's files, changed ones first, and once three letters are typed an *In
  files* group of matching lines (`GET /grep?q=`), each opening at its line. ⌘-click (Ctrl-click) a
  name or F12 opens where it's defined. With a language server for the file (`server/lsp.js`:
  found on PATH, in the repo's `node_modules/.bin`, or wisp's `~/.wisp/lsp`), its answers lead:
  definition, ⇧F12 references, hover (a quiet card above the name, mono), F2 rename across files
  (saved file, idle agent), and problems: the line number wavy-underlined in `--bad` / `--warn`
  with the message as its tip, and *n problems* in the head listing them. Without one, the text
  search answers (`GET /grep?def=`) and the head offers *Add TypeScript support* (a quiet button
  that moves nothing).
- **Revert a hunk, or the file.** In a git diff every hunk (the lines between two *n unchanged
  lines* gaps) has **Revert** on its first line at the visible right edge: sticky inside the
  sideways scroll and out of the flow, so the code never moves. It shows on hover or focus
  anywhere on the hunk (each hunk is its own `tbody`), always on touch, and is 44px to tap in the
  app (the pill stays the line's height). The file's `⋯` has **Revert file…**, which asks first
  (`ask`, danger, *Revert file*): a changed or deleted file comes back as the merge-base has it
  (`git checkout <merge-base> -- path`), an added one is removed. Both are instant: the hunk's rows
  (or the file's row) go at once, `POST /sessions/:id/changes/revert` puts it back
  (`server/hunks.js`: the file's lines there must still be the hunk's, and the hunk the one the
  page showed), then Changes reloads; refused, it comes back with a red toast. The server refuses
  while the agent works (*The agent is working on this task: wait for it, or stop it.*) and when
  the hunk moved (*This part changed since you looked: Changes is up to date now.*, and it
  reloads). The toast says *Reverted* with **Undo**: the text the file had just before (read with
  `GET /source` first, so it's exact) saved back through `PUT /source` with the hash the revert
  left, or restored / removed for a file that came or went. Added and deleted files, binaries and
  hunks cut short (*Show more*, or past what git sent) have no hunk Revert: revert the file.
- **Stage and commit**, as VS Code's Source Control and the Codex app's review pane (`changes.js`,
  `server/stage.js`). Only in a worktree's git diff. Each file row has a stage toggle before Viewed,
  in its style and in words: *Stage* while it has changes to stage, *Staged* (`aria-pressed`, the
  box filled) once all of it is, *Part* (the box half filled) when part of it is. A bare + or −
  beside the counts read as one of them. A committed file keeps its empty room, so
  Viewed and the rest never move. Each hunk's head row has **Stage** / **Unstage** before Revert,
  as wide as *Unstage* either way, shown like Revert (hover or focus, always on touch, 44px in the
  app); a committed hunk has none. Under the summary, while anything is staged or still to stage,
  the commit row: a one-line `.field` *Commit message* (focused empty, it takes the task's title,
  selected) with *2 staged* inside it at the right (*Commits all 3* when nothing is staged), then
  **Commit** (Enter or ⌘Enter). Everything is instant: the toggle, the hunk's button and the count
  flip at once, `POST /sessions/:id/changes/stage` (`{ path, hunk?, key?, unstage? }`) or
  `/changes/commit` (`{ message, all? }`) runs, then Changes reloads; refused, it flips back with a
  red toast. Committing clears the box at once (the text comes back if git refuses) and toasts
  *Committed abc1234*. A hunk is matched to git's own: Stage applies the hunks of `git diff` (index
  → folder) that fall in it to the index, Unstage the hunks of `git diff --cached` backwards; a hunk
  with nothing left to move, or that changed since (its key), is refused with 409 and Changes
  reloads. The server refuses while the agent works, like Revert. On a touch phone (stacked) the pencil
  makes room for the toggle (*Edit here* is in ⋯). ⌘K on a task: *Commit staged changes…* opens
  Changes with the box focused. `GET /changes` says per file `staged` / `unstaged` (untracked counts
  as unstaged) and per hunk `hunkStage`.
- Spells: `panel.changes.edit`, `panel.changes.open`, `panel.editor`, `panel.editor.code`,
  `panel.editor.save`, `panel.changes.revertHunk`, `panel.changes.viewed`, `panel.changes.viewedCount`,
  `panel.changes.stage`, `panel.changes.stageHunk`, `panel.changes.commit`.

## Layout

| Window | Layout |
|---|---|
| ≥ 1180px | list · task · panel. The panel is 480px by default; drag its inner edge to resize it (360px min, max `innerWidth − list − 480`). The size is kept in this browser (`wisp.panelW`), and double-clicking the edge resets it, like the list's grip. |
| 900–1179px | Opening the panel hides the list (`body.side-hidden`, **not saved** to `wisp.sideHidden`). `[` brings the list back and closes the panel: there's room for one of the two. Closing the panel brings the list back. |
| < 900px, and the Android app | Shell and PR are pages pushed over the task's, with Back to the task. See **Phones**. |

- **The task never goes under 480px.** The reading column fills what's left (`--read-w` still caps it).
- **The details column folds while the panel is open.** `body.panel-open` forces the narrow-pane bar
  (`.it-bar > .it-props`) even when the pane is ≥ 860px, so there's one right-hand column, never two.
- **The panel sits opposite the list.** If a spell puts the list on the right (`side-right`), the
  panel opens on the left.
- **Surface:** `--bg`, a 1px `--line` border on its inner edge, no shadow (it doesn't float). The
  head (`i-shell` *Shell* or `i-merge` *PR #412*, 13px semibold, then close) is 42px, the same height as `.tm-head`. The Shell screen is `--term-bg` in both themes,
  like Take over.
- The panel goes with the task. On home or a crew member's thread it's put away, and opening a task
  brings it back showing what it had. It reopens after a reload without an entry animation.

## Opening it

| Where | Item | Notes |
|---|---|---|
| Task head (`#splitHead .sh-acts`, before Close) | icon button `i-panel` (new) | `title`/`aria-label` *Show side panel (])* / *Hide side panel (])*, `aria-pressed`. Reopens what it last showed. Not shown when stacked. |
| Task's action row (`.it-actions`, after Take over) | **Shell** (`i-shell`, `.it-shell`) | Opens the shell; pressed while it shows, and a second click puts it away. Stacked, the shell's door replaces it (see **Phones**). |
| The task's PR row (`.pr-strip`, split view) | click anywhere but its buttons and GitHub link | Opens the panel on PR. Stacked it ends in a chevron. |
| PR pill (list rows) | click | Opens the panel on PR. |
| Right-click, More, details/bar actions, ⌘K | **Open shell** | Key `⌃\`` (Ctrl on every OS). Hidden on a computer that can't run one (see below), never disabled without a reason. |
| Same four | **Review PR #412** / **Review PRs** (several) | Key `P`. Only when the task has a PR. Sits beside the existing *Merge PR #412…*. |
| ⌘K | **Show side panel** / **Hide side panel** | Key `]`. |

- Keys: add `]` and `p` to `BUILT_IN` (keys.js), list all three in `shortcuts()` (kbd.js), and show
  them with `keyHint()`. `⌃\`` works from anywhere, including the reply box and the shell itself:
  in the shell it moves focus back to the reply box; anywhere else it opens the shell and focuses it.
- **Esc inside a focused shell goes to the shell** (vim, less, fzf). It never closes the panel or
  the task. Click outside the shell, or press `⌃\``, to leave it.
- What's remembered (in this browser, `wisp.panel`): whether it's open, what it last showed, and the width.
  Each task keeps its own shell on its computer. Switching tasks swaps the shell you see; it doesn't
  end the old one.

## Shell

**The place line** (one line, 32px, top of the Shell; the PR shows it too):

`[i-laptop | i-server | i-cloud] Studio · wisp-337d37 · ↑2 · 3 changed … [⋯]`

- Icon + place name, given once: `HERE` for this computer (in the app it's the computer's name), the
  machine's name for a remote, the cloud computer's name for the grid. No colour, no pill.
- Then the branch in `--mono` (it's the one that shrinks with `…`), then `↑n` commits ahead of base
  and `n changed` (uncommitted files), `--faint`, 11.5px, tabular-nums. Leave out a count that's 0.
- `⋯` menu: *Copy path*, *Copy branch name*, and when the task is local on a desktop (not `MOBILE`,
  not served from the grid): *Open worktree in editor* and *Open in Terminal* (use the app's name
  from Settings → *Take over in*: *Open in iTerm*).
- No worktree (the task runs in the project folder): show the folder, not a branch, and under the
  line one `--muted` sentence with `i-warn`: *Not a worktree: commands here change your project
  folder.*
- While the agent is working: *Claude Code is working in this folder too* (`--faint`) under the
  line, with no orb.

**The screen** reuses `term-emu.js` and `.tm-screen`/`.tm-rows`/`.tm-input` exactly (fonts, cursor,
the touch key row, `--vv-*` keyboard sizing on phones). It starts `$SHELL -l` in the folder.

- **One shell per task in v1.** (Several, as chips named after their foreground process, is v2.)
- **Starting:** the `.tm-wait` shimmer rows. Above them, in the screen's dim ink: *Starting zsh in
  wisp-337d37 on Studio*. A login shell runs its startup files before its first prompt (nvm and oh-my-zsh
  can take seconds, more while agents keep the computer busy): with nothing on screen after 4s the
  line says so, *Still starting zsh: it runs your ~/.zshrc first*, so a slow start never looks hung.
- **End:** an icon button `i-x` at the right end of the place line, *End shell*. If a process other
  than the shell is in the foreground, `ask()` first: *End the shell?* / blank line / *npm run dev
  is still running and stops with it.* / button *End shell* (`danger`). An idle shell ends at once.
- **When it exits** (exit, `⌃D`, the computer sleeping): the screen stays, and one row appears below
  it: *Shell ended (exit 0)* + **Start again**. No toast. A cloud computer that went to sleep:
  *Shell ended: Cloud went to sleep* + **Start again**.
- Archiving or deleting the task ends its shell. *Mark done* doesn't.

**When it can't run**, the screen area holds a centred block (icon, one sentence, at most one
button), never an empty black box:

| Case | Text | Button |
|---|---|---|
| Windows computer | *No shell on Windows yet: wisp's terminal needs macOS or Linux.* | *Open in Terminal* (local only) |
| Worktree removed (merged, cleaned up) | *This worktree is gone: it was removed after the merge.* | *Open shell in the project* |
| Task with no folder | It starts in the home folder, and the place line says `~`. | none |
| Remote wisp too old (route 404) | *Studio runs wisp 0.44: update it to open a shell there.* | *Open Machines* (desktop) |
| Computer offline | *Studio is offline.* | *Try again* |

**How it differs from Take over:** Take over is the *agent's* program, laid over the reading column
and titled with the agent's name (*In terminal* pill). The Shell is *yours*, in the panel, under
its place line. Same emulator, same dark screen; the place and the header tell them apart. Both can
be open at once.

## Changes

What the task changed, as one flat list of files whose diffs open in place (`changes.js`).

**Where it comes from.** A worktree: `GET /sessions/:id/changes`, git's diff from the merge-base of
the branch and its base to the folder as it is (committed or not), plus untracked files whole, as
added. From the merge-base, so what lands on the base later is never the task's. Without a worktree
(or with it gone, or a machine's wisp too old to answer) the edits wisp captured, turn by turn,
merged per file, and the note line says so: *Not a worktree: showing the edits wisp saw, not a git
diff.* A diff of the project folder would hold the user's own work too.

1. **Place line**, as on the other tabs (its count says *3 uncommitted*).
2. **Summary**, 36px: `7 files +15 −7 vs main` (*edits wisp saw* for captured ones), and at the
   right **Expand all** / **Collapse all** (skips folded and 300+ line files).
3. **Files**, sorted by path (keeps folders together; no tree: indents eat a 360px column). A row is
   30px (44px on touch): chevron · A/M/D/R badge · the path, its folder cut from the start before
   the name shortens (full path in `title`) · `+n` `−n` in fixed 5ch columns (a zero leaves its
   column blank) · `⋯` (*Open in editor*, desktop and not deleted; *Copy path*). A file name that
   doesn't fit beside the counts and controls takes the whole line and they drop to a 30px line
   under it, in the same columns at the right; a long folder alone never does that, it's cut. A name
   that doesn't fit there either is cut from its end. Phones always use two lines: the name alone,
   then the controls at the left and the counts at the right. Binary files say
   *binary* and have no chevron; a rename with no edits says *renamed*; deleted names are struck.
   Lockfiles, `*.min.*`, `dist/` and `build/` fold into one `--faint` row, *1 generated file* with
   its +/−, that unfolds in place. Past 200 files, *and 54 more*.
4. **A diff** opens under its row (`.b-diff.bare` rows, numbered by the new file; captured edits are
   snippets, so unnumbered with a gap row between). Its row sticks to the top while you read it.
   Past 300 lines, *Show 940 more lines*. A rename starts with *Renamed from old.js*. The first time
   a task's files show, the first one opens by itself, or all of them when there are three or
   fewer: only files **Expand all** would open count, so generated, 300+ line and viewed files
   don't. Files that arrive during a run follow the same rule, so a reload shows what you already
   see. Once you open, fold or view a file in that page, nothing else opens by itself. Spell prop `panel.changes` `autoOpen: false` turns it off.
5. **Comments on lines** (`comments.js`), as on GitHub: a **+** over the sign of the line under the
   pointer (absolute, so the code never moves), or the line number clicked or tapped; shift-click
   (touch: tap while the card is open) a second line for the lines between. Same card, tray and
   numbering as comments on an answer; the mark sits at the gutter's left, the lines lit with
   `--accent` at 12%. Only numbered lines (a git diff): captured edits have none.
6. **Viewed**, as on GitHub: each file row has a box and *Viewed* at its right, before the pencil
   (a real button, `aria-pressed`; the box alone in stacked panels, 44px in the app). Ticking it
   folds the file and dims its row (path, numbers and badge in `--faint`); the toggle keeps its
   width either way, so nothing moves. It's kept per task in this browser (`wisp.viewed`, the last
   100 tasks) against the file's diff: when the diff changes the file is unviewed again. The
   summary says *2 of 7 viewed* (tabular) once one is; **Expand all** skips viewed files.

**States:** the skeleton is the summary and six rows in their real shapes. Empty while the agent
works: *No changes yet. Files show here as Claude Code edits them.*; finished: *This task didn't
change any files.*; merged: *Everything here is in main now.* A failed first look: *Couldn't read
the changes: …* + **Try again**; a failed refresh keeps the list and says *Couldn't check just now*.

**Refresh:** the last list paints first. It asks again a second after each of the agent's edits,
every 10s while the task runs and the tab shows, when the task is fetched again (a turn ended), on
window focus and on opening the tab. Rows are keyed by path and patched in place, never
re-appended; open diffs stay open and are redrawn only when their file changed, keeping their
sideways scroll. A new file fades in on its own row.

**Ways in:** the action row's **Changes** (`i-file`, pressed while it shows, again to put it away),
`D`, **Show changes** in More, right-click and ⌘K, and *All changes in this task* under a turn's own
file list (which keeps showing that turn's diffs with its Revert). A page the agent puts up doesn't
take Changes' place: its Watch tab appears.

**Later:** a PR file row opening Changes at that file;
*This turn* / *All turns*; before/after for images.

## PR

Its head says **PR #412** (**PRs** with several), **PR** before there's one. Top to bottom:

1. **Place line** (the same as Shell's).
2. **Several PRs** (several repos): a row of chips, `repo #n` with the tone dot `prPill` already
   uses, and **Merge all** at the end while two or more are open. The rest shows the
   picked one.
3. **Title:** the PR's title (14px, two lines max, `title=` for the rest), then `#412` and the state
   (*Open*, *Draft*, *Merged*, *Closed*), then `branch → main` in `--mono`.
4. **The verdict:** one box, a 1px border mixing the state colour into `--line` (no stripe), one
   sentence and the one next step on the right:

   | State | Sentence | Button |
   |---|---|---|
   | All clear | *Ready to merge* | **Merge** (`.primary.sm`) |
   | Checks failing | *2 checks failing* | none (each failing check has its own *Ask to fix*) |
   | Checks running | *Waiting on 3 checks* | **Merge** (`ghost`; the confirm warns) |
   | Changes requested | *Changes requested by lena* | none |
   | Review required | *Needs a review from lena* | **Merge** (`ghost`; the confirm warns) |
   | Conflicts | *Conflicts with main* | **Fix conflicts** (existing `fixPr`) |
   | Draft | *Draft* | **Mark ready** |
   | Merged | *Merged into main · 3m ago* + the local sync line | none |
   | Closed | *Closed without merging* | none |

   Merge reuses `mergePr()`: `ask()` beside the button, *Squash-merge #412 into main?*, button *Merge
   PR*, `danger` with the warning when checks or reviews aren't done (*Merge anyway* then). While
   the PR shows, the task's own `.pr-strip` is hidden, so the verdict never shows twice.
5. **Checks**, grouped and in this order: **Failing** (open), **Running**, then the passed and skipped
   ones folded into a single row, *12 passed · 2 skipped*, which expands. Each row: a state icon in
   its state colour (`i-x` `--bad`, `i-clock` `--warn`, `i-check` `--good`), the check's name (it
   shrinks with `…`), *Required* in `--faint` when branch protection needs it, the duration on the
   right (`tabular-nums`, 11.5px; running ones count up), and **Logs** (`i-external`). Failing rows
   also get **Ask to fix**.
6. **Reviews:** one row per reviewer with their latest verdict (*Approved*, *Changes requested*,
   *Commented*), then *Waiting for lena* for requested reviewers who haven't answered. GitHub's
   avatar is 16px and round; if the image fails, show the initial.
7. **Conversation:** unresolved review threads first, oldest first, each with `file:line` (mono),
   the first comment and *2 replies*. Then the top-level comments, oldest first. Each one gets
   **Send to agent**.
8. **Files:** path, `+n` / `−n` in `--add`/`--del`, sorted by path. Show the first 8, then
   *and 14 more*. A file links to its diff on GitHub.
9. Foot: **Open on GitHub** (`i-github`), *Updated 12s ago* (`--faint`), refresh (`i-replay`, the
   ring spinner while it loads).

**Noise, folded and never deleted** (a single row each, `--faint`, which expands on click):
- Top-level comments by bots (`[bot]` logins or `type: Bot`): *4 bot comments*. This includes
  wisp's own comments and CI and coverage bots.
- Resolved and outdated threads: *3 resolved*.
- Comments GitHub has minimised.
- An **unresolved review thread always shows**, whoever wrote it (Copilot and CodeRabbit threads
  are work to do), with *bot* in `--faint` after the author.

**No PR yet:** it still shows the place line, then *Not shipped yet: 2 commits and 3 changed
files on wisp-337d37*, then **Ship it…** (`shipDialog`). While shipping, the steps show here
(`renderShipRun`), not in a dialog.

**Refresh:** paint the last detail we saw first (and keep it for the phone app's cache). Refetch when
it opens, every 20s while a check is running and it's visible, every 60s otherwise while
visible, and on window focus. Hidden, it doesn't poll (the summary's minute check still runs).
Rows update in place (keyed by check or comment id) and are never re-appended.

**Skeleton:** the real shapes at their real heights: a title line, the verdict box, three check
rows and two comment blocks, in `.skel`. They all swap at once with a fade.

## Ask to fix and Send to agent

Both **fill the task's reply box; they don't send**. The reply box is focused with the draft:
- *Ask to fix*: *The `test (ubuntu, 22)` check failed on PR #412. Fix it and push.* + the last 80
  lines of the failing log (`gh run view --log-failed`) in a fenced block.
- *Send to agent*: *lena commented on `server/pty.js:42` in PR #412:* + the quoted comment.

When the task can't take a follow-up, the button isn't there. Stacked and in the app, the page goes
back to the task with the draft in place. There's no toast: the filled box is what you see.

## Phones

Stacked (< 900px) and always in the Android app. Checked at 390px, and 360px for the tight rows.

**Getting there: doors on the task page, then a page of its own.** No tabs or segments: the task
page is the task, and Shell and PR are places it leads to.

- Under the task's actions, two full-width rows, 44px+, 9px radius, each ending in `i-chevron`
  (`--faint`) so it reads as *this opens a page*:
  1. **The PR row** (`.pr-strip`), in its tone as before: `PR #412`, its state line and the chevron
     on top; *Check now*, *GitHub* and **Merge** (or *Fix conflicts*) on a line under, Merge at the
     right end. Tapping anywhere but those buttons opens the PR page.
  2. **The shell's door** (`.shell-door`, `--bg-2`, 1px `--line`): `i-shell` **Shell**, then where it
     runs (*This computer*, the machine's or cloud computer's name). While your shell is still
     running there it says *Running on Studio* after a `--good` dot, so you know you left
     something going. The action row's Shell icon is hidden here: beside Take over's it read as a
     twin.
- A tap pushes the page in from the right (`stack-in`, the task page's own slide; none with reduced
  motion). It covers the whole screen, sized to what the keyboard leaves (`--vv-*`, like Take over).
- **Its head is the task page's head:** the same 56px box and Back on the same spot, so the thumb
  never hunts; then `i-shell` **Shell** or `i-merge` **PR #412**, 15px semibold. No close button.
- **Swipe (the app):** dragging the task page to the left brings the panel in under the finger,
  on the tab it last showed (Changes until you've picked another); dragging the panel to the right
  takes it back to the task. The panel follows the finger 1:1, the task slides a quarter of its
  width under it and dims (to 18%); letting go past 40% of the way, or a flick (0.3px/ms), finishes
  the move at the finger's speed (140–320ms), otherwise it springs back. Only `transform` and
  `opacity` move, so no frame waits on layout. It never focuses the shell (no keyboard). Not from the
  screen's edges (Android's Back), not from a text box, and not inside something that still scrolls
  that way (a diff, the key row): that scroll goes first, then the swipe. `panel.swipe: false` turns
  it off. Phone browsers keep their own sideways gestures.
- **Back** (the head's, the phone's, `Esc`) returns to the task, where it was scrolled. The page
  takes one `onBack` entry above the task's, so a second Back goes to the list.
- Opening a task lands on the task. The page isn't remembered per task on phones: the transcript is
  home.
- **Reading a long task:** the bar (facts, branch, actions, the PR row, the shell's door) scrolls
  away with the task instead of staying pinned: on a phone it was a third of the screen. Once its
  actions are out of sight a **mini row** pins in their place, one 48px row with a 1px `--line`
  under it: the state pill, the actions as 40px icons (Transcript, Rerun, Done, More), then at the
  right end the PR as a chip in its tone (`● #412`, `+1` with more PRs; *Ship it* before there's
  one) and the shell icon (a `--good` dot while yours runs). The chip and the icon open their
  pages; the rest do what the bar's buttons do. It hangs from a sticky box of no height, so it
  fades in (0.15s, 8px) without moving the text, and goes when you scroll back to the bar.
- The reply box stays on the task. *Shell* gives the bottom to the key row, *PR* to its merge bar.
- The `i-panel` toggle isn't shown.

**Shell**

- The screen fills down to the key row, sized to the visual viewport (`--vv-*`, as Take over).
- **Keyboard up:** the page shrinks to what the keyboard leaves; the head with Back stays: it's
  the way out.
- **Reading without the keyboard:** dragging the screen scrolls its history and never focuses it;
  only a tap brings up the keyboard. The phone's Back puts the keyboard away first (Android does).
- Three additions to Take over's key row, for both (Take over gets them too):
  1. **`^C`** right after *Esc* (`aria-label`/`title` *Interrupt (Ctrl+C)*): stopping `npm run dev`
     is one tap, not *Ctrl* then *c*.
  2. **Ran-here chips**, brought forward from *Later* for touch screens only in v1: the last 3
     distinct commands the agent ran in this task, as `--mono` chips in one sideways-scrolling row
     between the place line and the screen, 44px tall. Shown only while the shell is at its prompt.
     A tap types the command without Enter and focuses the shell. Each chip has
     `title`/`aria-label` *Type npm test*. No label in front of them.
  3. **The key row stays put**: the same keys in the same order whatever is focused; `^C` and the
     chips never move other keys. (`.tm-keys` already scrolls sideways; Paste stays last.)
- No font-size control and no pinch zoom in v1: the screen keeps Take over's size.

**PR**

- **Merge bar** pinned at the bottom where the reply box sits on *Task*: the verdict sentence on the
  left (one line, ends in `…`) and its one button on the right (*Merge*, *Fix conflicts*, *Mark
  ready*), 56px tall, buttons 44px. The verdict box at the top isn't shown on phones, so the verdict
  appears once. Merge's `ask()` opens above the bar (`fitToScreen`).
- Checks stay grouped the same way (Failing open, Running, passed folded into one row). Every row
  is 44px. A failing row takes two lines: the icon, name and duration on the first, then *Ask to
  fix* and *Logs* as 44px text buttons on the second. Other rows open their log on a tap of the
  whole row (no separate *Logs*; `i-external` at the right end says it leaves wisp).
- *Required* drops before the name shortens; durations stay in their column.
- Comments: *Send to agent* is a 44px text button under the comment, never on hover.
- Files: the whole 44px row opens the diff on GitHub.
- Several PRs: the chips row scrolls sideways, *Merge all* pinned at its end.
- Links (*Logs*, files, *Open on GitHub*) open in the phone's browser (`Ssh.openExternal` in the app).
- **Ask to fix / Send to agent** go back to the task with the draft in the reply box, focused, the
  transcript at its end. No toast.

**Words:** *Shell*, *Running on Studio*, *PR #412*; *^C* (*Interrupt (Ctrl+C)*); chips *Type npm test*. No
keyboard hints anywhere on this page (`.key-hint`).

## Words

| Thing | Text |
|---|---|
| Head (tabs) | *Changes*, *PR #412* / *PRs* / *PR*, *Shell*, *Preview*, *Watch* |
| Preview | *Run*, *Run again*, *Starting · npm run dev*, *Running · localhost:41664*, *Pick element*, *Logs*, *Restart*, *Stop app*, *Open in browser*, *Exited with code 1*; actions *Run app* / *Stop app* |
| Changes | *7 files +15 −7 vs main* · *edits wisp saw* · *Expand all* / *Collapse all* · *1 generated file* · *Show 940 more lines* · *Show changes* (`D`) · *All changes in this task* |
| Task's ways in | *Shell* (action row; on phones the door, *Running on Studio*), the PR row |
| Head toggle | *Show side panel (])* / *Hide side panel (])* |
| Actions (all places) | *Open shell*, *Review PR #412*, *Review PRs*, *Show side panel* / *Hide side panel* |
| Place line menu | *Copy path*, *Copy branch name*, *Open worktree in editor*, *Open in iTerm* |
| Toasts | *Path copied*, *Branch name copied*, *Marked ready*; merge keeps its toast (*Merged #412.* + sync) |
| Shell end | *End shell*; *Shell ended (exit 0)* · *Start again* |
| PR buttons | *Merge*, *Merge all*, *Mark ready*, *Fix conflicts*, *Ask to fix*, *Send to agent*, *Logs*, *Open on GitHub* |

Never generic: no *Loading…*, no *Working…*. The starting line names the shell, the folder and the
place.

## Motion

- The panel appears with `fade-in` 0.15s and its content rises 6px. The task column reflows at once:
  never animate `width`, and no transition while dragging.
- No entry animation after a reload, on a task switch or on a refresh: only when you open it.
- Stacked, Shell and PR slide in over the task like the task slides in over the list (`stack-in`),
  only when you open them: never on a refresh or a swap between the two.
- The shimmer and the running checks' clock already have `prefers-reduced-motion` rules. Add one
  for anything new that loops.

## Watch

The page an agent keeps beside its task while it works (`wisp_watch`, `server/watch.js`,
`web/js/features/watch.js`). The agent writes the page and sends it its progress; wisp shows it.

- **Opens by itself** when the agent puts a page up on the task you're looking at (split view, not
  stacked), unless the panel shows that task's shell: you're typing there. Otherwise its doors are
  the task's **Watch** button (`i-eye`, in the action row after Shell, pressed while it shows; also
  in the pinned mini row), **Watch** in the working card next to Stop, *More*, right-click and ⌘K.
  None of them show before there's a page.
- **Head:** `i-eye` and the page's title. No place line: it's about the page, not the folder.
- **Caption line** (32px): a green dot pulsing while the task runs, then what the agent says it's
  doing (*Converting cart.js*). Done: `i-done` and its last caption (*All 6 files converted*), or
  *Finished*. Stopped without closing: `i-pause` *Stopped*.
- **The page** fills the rest, on `--bg`, sealed (`sandbox="allow-scripts"`, no network beyond https
  scripts, styles and fonts; `web/js/watch-doc.js`), in wisp's theme through its CSS variables, and
  follows light and dark without reloading. A new state is posted into it: it never reloads for one,
  so nothing flashes. Only a new page (`rev`) reloads it. Loading, a placeholder in its shapes.
- **A running app** (`url`): the agent's dev server, loaded like the preview block (its sandbox, the
  grid's preview address for localhost). The caption line adds the address (mono, `--faint`, right)
  and an `i-external` button that opens it in its own tab. `navigate` and `reload` load the frame
  again at the new address; there's no state to post. Read away from the agent's computer with no
  preview address, a line under the caption says it points at the agent's computer.
- **Run it yourself** (only when the agent gave one): the command in a mono box, a copy button that
  copies `cd <folder> && <command>`, and the agent's note under it. `--bg-2`, 1px `--line` on top.
- **Phones:** a page over the task with Back, never pushed by itself: the working card's **Watch**
  is the way in. Copy is 40px.

## Preview

The task's app, run from its worktree and shown beside it (`server/runs.js`, `web/js/features/run.js`),
as Conductor's Run script or Vibe Kanban's dev-server preview. The tab sits after Shell, only on a
task with a worktree (that never changes for a task, so nothing moves); Watch stays last.

- **How it runs:** `.wisp/worktree.json`'s `run` (and optional `port`), else the repo's Conductor
  run script (`.conductor/settings.toml`, or `conductor.json`), else a guess from package.json
  (`npm run dev`, else `npm start`), else what you type. In the worktree, with `PORT`
  set to a port wisp keeps for the task while it's free (41000 + its id's hash) unless the config
  sets one, and `BROWSER=none`. Its own process group: **Stop** ends what it started (Windows:
  `taskkill /T`). Deleting or archiving the task, or quitting wisp, stops it. The last 2000 lines of
  output are kept, colours stripped. Its address is the first local URL it prints, else `PORT`.
- **Not running:** the intro (`i-play`, *Run the app from this task's folder and see it here.*), a
  *Command* label, the command in a `.input.mono` box and a primary **Run**. A command of several
  lines (a Conductor script) gets a textarea with the same classes, as tall as its lines up to 6,
  then it scrolls; Enter there is a new line, **Run** stays at the top of the row. The line under
  it says where the command came from: *From `.wisp/worktree.json`*, *From
  `.conductor/settings.toml`* (a file that can't be read says so instead: *couldn't read
  `.conductor/settings.toml`: line 3: …*), or *From package.json: a guess. Set `run` in
  `.wisp/worktree.json` to fix it.* Your edits to the box are kept per task.
- **Running:** a 36px bar under the place line: a dot (amber, pulsing, *Starting · `npm run dev`*
  until the port answers; then green, *Running · localhost:41664*), then **Pick element**
  (`i-target`), **Logs** (`i-terminal`, pressed while open), **Restart** (`i-replay`), **Stop**
  (`i-stop`, red on hover) and **Open in browser** (`i-external`, the app's own address). Until it
  answers, its output fills the frame's place (never an empty box); then the frame. **Logs** opens
  the output under the frame (38%, the terminal's `--term-*` colours), following the end.
- **Failed** (it exited on its own): `i-warn` *Exited with code 1* (or *Stopped by SIGKILL*), its last
  12 lines in the terminal's colours, the command box and **Run again**.
- **Instant:** Run shows the bar at once, Stop the empty state at once; a refusal puts it back with a
  red toast. While shown it asks every second until the app answers (or while Logs are open), else
  every 4s; hidden, never.
- **The frame** loads the app through a small proxy wisp opens for it on a port of its own
  (42000 + hash): the same app with `X-Frame-Options` and CSP `frame-ancestors` dropped and one
  script added to its pages; websockets (live reload) pass through. Its own origin, like the app:
  wisp's API stays out of its reach. On a grid box it loads at the box's preview address; a
  machine's task, or the phone app (it reaches wisp through a tunnel), gets a line saying the
  address is the task's computer's and may not load here, and no Pick.
- **Pick element** is enabled once the page's script says hello (it says so again after each load).
  Pressed: the cursor is a crosshair over everything in the page, the pointer outlines the element
  under it in `--accent` with its `tag.class` above; a click doesn't reach the app. It describes
  the element in the task's reply box, added under what's there, as plain text you can edit:
  *In the preview at /settings, `<button class="primary">` "Save" (selector: `main > form > button.primary`):*,
  then a line *HTML:* (its markup, three levels down, about 600 characters, the rest as …; no
  scripts, no svg paths) and a line *Styles:* (size, display, margin, padding, gap, colour,
  background, font, border, radius; what's at its default stays out). The page's first address has
  no *at*. One pick stays under 2,000 characters whatever the page sends (`pickLine` cuts it again:
  the page is the app's). What's in a password or hidden field never comes along. The box takes
  the focus with the caret on a new line for what to change; nothing sends until you do. Picks
  count only while Pick is pressed, so a page can't write in the box by itself. Escape or Pick
  again ends it. Stacked, the page goes back to the task first.
- **Actions:** *Run app* / *Stop app* (`i-play` / `i-stop`) in More, the right-click menu and ⌘K.
  *Run app* opens Preview and runs the last command, the config's or the guess; with nothing to go
  on, or after a failure, it opens Preview on that.
- **Phones:** the fifth segment of the page's head (equal widths); the bar is 44px with 40px
  buttons.
- **Keyboard:** the bar's rebuilt as its state changes, so what had focus keeps it (`paintBar`), or the
  bar itself (`.rn-bar`, `tabindex=-1`) when that control is off for now. Run by keyboard lands on the
  bar, Stop or an exit on the command, Escape in the page on Pick. A pointer's focus isn't moved: on a
  phone a box that takes focus opens the keyboard.

## Spells

- Changes: `PARTS` `panel.changes`, `panel.changes.summary`, `panel.changes.list`, `split.changes`
  (the action row's button); `PART_PROPS` `panel.tab` takes `changes`, and `panel.changes`
  `{ generated: bool }` lists generated files unfolded; `panel.changes.comment` (a line's **+**) and
  `panel.changes.commentMark` (a commented line's number); `panel.changes.revertHunk` (a hunk's
  Revert), `panel.changes.viewed` (a file's Viewed toggle) and `panel.changes.viewedCount` (*2 of 7
  viewed*); `panel.changes.stage` (a file's Stage toggle), `panel.changes.stageHunk` (a hunk's Stage /
  Unstage) and `panel.changes.commit` (the commit row).
- `SLOTS`: `panel.head`, buttons in its head. It acts on the task, so it also goes in
  `CARD_SLOTS` and `BUTTON_SLOTS`.
- `PARTS`: `panel`, `panel.tabs` (its tabs again), `panel.place`, `panel.shell`, `panel.pr`, `panel.checks`,
  `panel.conversation`, `panel.files`, `panel.watch`, `watch.caption`, `watch.run`, `split.watch`,
  `panel.preview`, `panel.preview.bar`, `panel.preview.run`, `panel.preview.pick`, `panel.preview.logs`. The verdict and Merge stay out of `PARTS`: a spell can't hide
  what decides a merge.
- `PART_PROPS`: `panel.width` (`px`), `panel.tab` (`changes` | `pr` | `shell` | `preview` | `watch`), `panel.swipe` (`bool`: swiping
  brings it in and out in the phone app), `panel.pr.bots` (`bool`: show bot comments unfolded).
- `ICONS`: `panel`, `eye`.
- `SETTINGS`: `watch` (`on` | `off`): agents are offered `wisp_watch`.

## v1 / later

**v1:** the layout above, Shell (one per task, local, remote and cloud), the PR with the
noise folded, Merge / Mark ready / Fix conflicts, *Ask to fix*, *Send to agent*, the keys, the
phone doors and pages (with `^C` and the ran-here chips on touch), spells.

**Later, in order:**
1. **Ran-here chips on desktop** (touch screens get them in v1, see **Phones**).
2. Several shells per task, as chips named after their foreground process.
3. **Ports:** when something in the shell listens on a port, a chip *localhost:5173*. On a remote
   or cloud computer it opens through wisp's proxy. (Preview covers the app you run on purpose.)
4. Check history: this check's last five runs on the branch, as dots, to tell a flaky check from a
   broken one.
5. A review comment's `file:line` jumps to that diff in the transcript when the task touched it.
6. Take over in the panel, instead of covering the reading column.
