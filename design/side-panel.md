# The side panel: Shell and PR

A third column in split view, on the task's far side from the list, for doing things with what an
agent made without leaving wisp. It has two tabs: **Shell**, a real shell in the task's folder on
whichever computer ran the task, and **PR**, the task's pull request without the noise. Code and
CSS call it the *side panel*. On screen it has no name of its own: its tabs and its toggle label it.

## Layout

| Window | Layout |
|---|---|
| ≥ 1180px | list · task · panel. The panel is 480px by default; drag its inner edge to resize it (360px min, max `innerWidth − list − 480`). The size is kept in this browser (`wisp.panelW`), and double-clicking the edge resets it, like the list's grip. |
| 900–1179px | Opening the panel hides the list (`body.side-hidden`, **not saved** to `wisp.sideHidden`). `[` brings the list back and closes the panel: there's room for one of the two. Closing the panel brings the list back. |
| < 900px, and the Android app | No third page: the task page gets segments, *Task · Shell · PR #412*, that swap its body in place. Back always returns to the list. See **Phones**. |

- **The task never goes under 480px.** The reading column fills what's left (`--read-w` still caps it).
- **The details column folds while the panel is open.** `body.panel-open` forces the narrow-pane bar
  (`.it-bar > .it-props`) even when the pane is ≥ 860px, so there's one right-hand column, never two.
- **The panel sits opposite the list.** If a spell puts the list on the right (`side-right`), the
  panel opens on the left.
- **Surface:** `--bg`, a 1px `--line` border on its inner edge, no shadow (it doesn't float). The
  tab row is 42px, the same height as `.tm-head`. The Shell screen is `--term-bg` in both themes,
  like Take over.
- The panel goes with the task. On home or a crew member's thread it's put away, and opening a task
  brings it back with the tab it had. It reopens after a reload without an entry animation.

## Opening it

| Where | Item | Notes |
|---|---|---|
| Task head (`#splitHead .sh-acts`, before Close) | icon button `i-panel` (new) | `title`/`aria-label` *Show side panel (])* / *Hide side panel (])*, `aria-pressed`. Not shown when stacked: the segments replace it. |
| PR pill (row, bar) | click | Opens the panel on PR. |
| Right-click, More, details/bar actions, ⌘K | **Open shell** | Key `⌃\`` (Ctrl on every OS). Hidden on a computer that can't run one (see below), never disabled without a reason. |
| Same four | **Review PR #412** / **Review PRs** (several) | Key `P`. Only when the task has a PR. Sits beside the existing *Merge PR #412…*. |
| ⌘K | **Show side panel** / **Hide side panel** | Key `]`. |

- Keys: add `]` and `p` to `BUILT_IN` (keys.js), list all three in `shortcuts()` (kbd.js), and show
  them with `keyHint()`. `⌃\`` works from anywhere, including the reply box and the shell itself:
  in the shell it moves focus back to the reply box; anywhere else it opens the shell and focuses it.
- **Esc inside a focused shell goes to the shell** (vim, less, fzf). It never closes the panel or
  the task. Click outside the shell, or press `⌃\``, to leave it.
- What's remembered (in this browser, `wisp.panel`): whether it's open, the last tab, and the width.
  Each task keeps its own shell on its computer. Switching tasks swaps the shell you see; it doesn't
  end the old one.

## Shell tab

**The place line** (one line, 32px, top of the Shell tab; the PR tab shows it too):

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
  wisp-337d37 on Studio*.
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

## PR tab

The tab says **PR #412** (**PRs** with several). Without a PR it says **PR**, and it's absent if the
project isn't a git repo with a GitHub remote. Top to bottom:

1. **Place line** (the same as Shell's).
2. **Several PRs** (several repos): a row of chips, `repo #n` with the tone dot `prPill` already
   uses, and **Merge all** at the end while two or more are open. The rest of the tab shows the
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
   this tab shows, the task's own `.pr-strip` is hidden, so the verdict never shows twice.
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

**No PR yet:** the tab still shows the place line, then *Not shipped yet: 2 commits and 3 changed
files on wisp-337d37*, then **Ship it…** (`shipDialog`). While shipping, the steps show here
(`renderShipRun`), not in a dialog.

**Refresh:** paint the last detail we saw first (and keep it for the phone app's cache). Refetch when
the tab opens, every 20s while a check is running and the tab is visible, every 60s otherwise while
visible, and on window focus. A hidden tab doesn't poll (the summary's minute check still runs).
Rows update in place (keyed by check or comment id) and are never re-appended.

**Skeleton:** the real shapes at their real heights: a title line, the verdict box, three check
rows and two comment blocks, in `.skel`. They all swap at once with a fade.

## Ask to fix and Send to agent

Both **fill the task's reply box; they don't send**. The reply box is focused with the draft:
- *Ask to fix*: *The `test (ubuntu, 22)` check failed on PR #412. Fix it and push.* + the last 80
  lines of the failing log (`gh run view --log-failed`) in a fenced block.
- *Send to agent*: *lena commented on `server/pty.js:42` in PR #412:* + the quoted comment.

When the task can't take a follow-up, the button isn't there. Stacked and in the app, the page switches
to the *Task* segment with the draft in place. There's no toast: the filled box is what you see.

## Phones

Stacked (< 900px) and always in the Android app. Checked at 390px, and 360px for the tight rows.

**Getting there: segments on the task page, not a third page.**

- Under the task head, full width: a segmented row **Task · Shell · PR #412**, styled as `.mem-tabs`
  (equal-width buttons, the picked one on `--surface` with `--shadow-1`). The row is 44px, the pill
  36px inside it; it stays with the head when the transcript scrolls.
- A tap swaps the page's body **in place**. Segments take no history entry and never stack: the
  task page keeps its one `onBack` entry, so Back (head or the phone's) always returns to the list,
  from any segment. No swipe between segments: it would fight the shell and sideways-scrolling code.
- Segments shown: *Task* always, *Shell* when the computer can run one, the PR one when the project
  has a GitHub remote (*PR* before there's a PR, *PRs* with several). With only *Task*, no row.
- Opening a task lands on *Task*. Coming from the PR pill lands on *PR*, from *Open shell* on *Shell*.
  The segment isn't remembered per task on phones: the transcript is home.
- The reply box shows on *Task* only. *Shell* gives the bottom to the key row, *PR* to its merge bar.
- The head (Back, title, actions) is the same on all three. The `i-panel` toggle isn't shown.

**Shell**

- The screen fills down to the key row, sized to the visual viewport (`--vv-*`, as Take over).
- **Keyboard up:** the title clamps to one line and the place line hides, so the screen keeps about
  14 rows on a Pixel. The segment row stays: it's the way out.
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
- **Ask to fix / Send to agent** switch to *Task* with the draft in the reply box, focused, the
  transcript at its end. No toast; the *PR* segment keeps its scroll for when you come back.

**Words:** *Task*, *Shell*, *PR #412*; *^C* (*Interrupt (Ctrl+C)*); chips *Type npm test*. No
keyboard hints anywhere on this page (`.key-hint`).

## Words

| Thing | Text |
|---|---|
| Tabs | *Shell*, *PR #412* / *PRs* / *PR*; on phones *Task* first |
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
- Stacked, switching segments swaps the body with no slide: segments are places on one page, not
  pages. The task page itself still slides in from the list (`.stack-in`).
- The shimmer and the running checks' clock already have `prefers-reduced-motion` rules. Add one
  for anything new that loops.

## Spells

- `SLOTS`: `panel.head`, buttons beside the tabs. It acts on the task, so it also goes in
  `CARD_SLOTS` and `BUTTON_SLOTS`.
- `PARTS`: `panel`, `panel.tabs`, `panel.place`, `panel.shell`, `panel.pr`, `panel.checks`,
  `panel.conversation`, `panel.files`. The verdict and Merge stay out of `PARTS`: a spell can't hide
  what decides a merge.
- `PART_PROPS`: `panel.width` (`px`), `panel.tab` (`shell` | `pr`), `panel.pr.bots` (`bool`: show bot
  comments unfolded).
- `ICONS`: `panel`.

## v1 / later

**v1:** the layout above, Shell (one per task, local, remote and cloud), the PR tab with the
noise folded, Merge / Mark ready / Fix conflicts, *Ask to fix*, *Send to agent*, the keys, the
phone segments (with `^C` and the ran-here chips on touch), spells.

**Later, in order:**
1. **Ran-here chips on desktop** (touch screens get them in v1, see **Phones**).
2. Several shells per task, as chips named after their foreground process.
3. **Ports:** when something in the shell listens on a port, a chip *localhost:5173*. On a remote
   or cloud computer it opens through wisp's proxy.
4. Check history: this check's last five runs on the branch, as dots, to tell a flaky check from a
   broken one.
5. A review comment's `file:line` jumps to that diff in the transcript when the task touched it.
6. Take over as a third tab of the panel, instead of covering the reading column.
