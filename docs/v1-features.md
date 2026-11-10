# v1 features and where v2 stands

What v1 (`origin/main`, wisp-agents 0.1.0 → Unreleased after 0.57.0) gives a user, one row per feature, with a
scenario a tester can run and the v2 status found in this folder on 2026-11-10. Counts and the top gaps are in
`docs/v1-features-summary.md`.

**Sources.** v1's `CHANGELOG.md` (632 bold entries plus the plain-bullet releases 0.1–0.11; Added, Changed,
Fixed), `web/js/features/*` (99 modules), `web/js/features/keys.js` (the shortcuts), the Settings panes, the
answer block types, the MCP tools and the CLI. A later entry that changed a feature is merged into its row
(the row describes the final v1 behaviour). A Fixed entry got its own row only when it describes behaviour a
user relies on; most Fixed entries are layout polish and are covered by the parity row (F-look-1).

**How the v2 status was found.** By searching `plugins/*`, `crates/*`, `packages/*`, `apps/*`, the manifests'
`contributes.commands` and `crates/wisp/src/args.rs`. The terms:

- **built**: a server command (or tool) does it, and a mounted GUI screen or the CLI reaches it end to end. For a
  feature whose scenario is a GUI interaction, the GUI must do it.
- **partial**: some of it is there; the cell says what's missing. The most common case is *server and CLI only*:
  the host command exists and `wisp <plugin> <verb>` reaches it (ADR-0022), but no mounted GUI shows it.
- **missing**: no code found for it.
- **dropped**: an ADR removes it (cited).

**What "mounted GUI" means today.** `apps/web` registers a plugin UI only if its `ui/src/index.ts` has a default
`definePluginUi(…)`. Mounted: the shell frame (`packages/shell/src/frame`: Home with the launcher, the sidebar
with the crew rail, the task view with its turns, answer blocks, details actions and reply box, the palette, the
⌃Tab switcher, the shortcuts sheet, the Settings frame), `shell-list` (the task list), `shell-task` (the
reply-box foot with questions and the queue; the side panel's Changes), `ship` (Ship dialog, PR strip, merge
confirm), `goal` (the band, judges), `machine` (This Mac page), Settings panes from `shell-settings` (General,
Notifications, Keys), `router` (Auto), `update` (Updates), `worktrees` (Worktrees). **Not mounted** (no index or
an empty definition): `crew` (registers nothing: no member thread or editor), `stuff`, `automations`,
`connectors`, `accounts`, `machines`, `budget`, `grid-client`, `plugins`, `telemetry`, `learn`, `issues`,
`shell-composer` (queue list, runner picker, `@` and `/` text models), `shell-home` (tips data, notifications).
`shell-task`'s `TaskHead`, `Transcript`, `PlanView`, `AskCard`, `HaltCard`, `HeldCard`, `Receipt` and
`WhatChanged` are stubs that render nothing; its PR and Shell side panes show a placeholder. Registered
shortcuts are only ⌘K, ⌘L, N, Esc, ? and [ (`packages/shell/src/builtins.tsx`). `docs/v2-sweep-commands.md` lists
62 UI → server mismatches (commands the UI sends that no manifest lists); some were added since.

No v2 GUI view passes `qa/parity.mjs` yet (baseline 0/96, `docs/v2-queue.md` item 7), so no GUI row is "built"
in the sense of *looks like v1*: F-look-1 tracks that once.

---

## 1. Tasks and the list (`TASK`)

| ID | v1 | Scenario (given / when / then) | v2 | Evidence or gap |
|---|---|---|---|---|
| F-task-1 | 0.1.0 | Given a project, when I send a prompt, then a task starts in the background and its answer shows as cards (hero, diff, tests…) | built | `runtime.create`; `HomeView.tsx` sends it; `TaskView.tsx` renders `Answer` blocks |
| F-task-2 | 0.11.0 | Given Home, when I press Send, then the box clears and the task shows in Working as *Starting up* at once | built | optimistic create in `packages/shell/src/frame/HomeView.tsx`; text put back on refusal |
| F-task-3 | 0.26.0 | Given tasks in several states, when I look at the sidebar, then they sit in Needs you, Working, Done and Archived | built | `plugins/shell-list/ui/src/ui/TaskList.tsx` |
| F-task-4 | 0.40.0 | Given the list, when I click *Needs you*, *Crew* or *Working* (or Tab + Enter), then that section folds | partial | sections render; folding every section and keyboard folding not verified in `TaskList.tsx` |
| F-task-5 | 0.24.0 | Given more than 60 done tasks, when I scroll Done, then its count is the real total and older ones load | partial | list renders; no `VirtualList`/paging found in `shell-list` (AGENTS.md requires it past 200 rows) |
| F-task-6 | 0.48.0 | Given a task row, when I read it, then a third line names harness logo, model and where it ran | partial | `RowParts.tsx` draws rows; parity of the third line not reached |
| F-task-7 | 0.3.0 | Given a task, when I right-click it, then a menu offers open, rename, mark done, for later, archive, delete, rerun, fork, mention | partial | menu entries in `Sidebar.tsx`/`TaskView.tsx`; *Mention in prompt*, *Save as recipe*, *Copy task ID*, *Share…* not found |
| F-task-8 | 0.3.0 | Given a task, when I press A (or Archive), then it moves to Archived and a new question brings it back | partial | `runtime.archive` + GUI menu; the `A` key isn't registered |
| F-task-9 | 0.45.0 | Given a task, when I rename it (M, Enter saves, Esc cancels), then I stay on the task | partial | `runtime.rename` exists; GUI rename reached from the menu; `M` key not registered |
| F-task-10 | 0.43.0 | Given a done task, when I press L (or swipe left on phone), then it's parked under For later; L again unparks | partial | `runtime.forLater`, `later.park`; GUI menu uses forLater; `L` key and the swipe missing |
| F-task-11 | 0.43.0 | Given the open task, when I mark it done, archive or delete it, then wisp goes to the next task that needs me (feed) or New task | partial | `runtime.setState` from `TaskView.tsx`; next-needs-you navigation not found |
| F-task-12 | 0.39.0 | Given a running task, when I delete it, then it's gone without flashing through Needs you or notifying | built | `runtime.delete` stops the run first (`plugins/runtime/host/src/ops.rs`) |
| F-task-13 | 0.39.0 | Given a task a recipe or trigger started, when I see its row, then it has a bolt (recipe) or the trigger's mark | missing | no row marker for automated starts in `shell-list` |
| F-task-14 | Unrel. | Given a task that crashed, hit a limit or was refused, when I see its row, then the pill says which | partial | runtime records the halt reason; `HaltCard` is a stub and the row shows the state only |
| F-task-15 | Unrel. | Given a new task, when its first answer lands, then the task keeps a name from what I asked, not the agent's headline | partial | `runtime` sets a title on create; the naming rule (and a quick answer naming its task) not verified |
| F-task-16 | 0.32.0 | Given an open task, when I reload or copy the address, then `#/s/<id>` opens the same task | built | `browserHistory` in `@wisp/client`; navigation is URL-backed |
| F-task-17 | 0.32.0 | Given I scrolled a task, when I reload and open it again, then I'm back where I was | partial | no scroll-position store found |
| F-task-18 | 0.31.0 | Given I opened a task before, when I open it again, then it shows at once from cache | built | IndexedDB persist in `@wisp/client` (ADR-0006) |
| F-task-19 | 0.3.0 | Given many tasks, when I press ⌘K and type, then a fuzzy search finds tasks, projects and commands | built | `packages/shell/src/palette/` |
| F-task-20 | 0.51.0 | Given past work, when I type 3+ letters in ⌘K, then it finds words inside prompts and answers | partial | `runtime.search` (FTS in `wisp-store`); the palette doesn't call it |
| F-task-21 | 0.43.0 | Given agents tagged tasks (`wisp_tag`), when I search a topic, then tagged tasks match | partial | `wisp_tag` tool exists; palette doesn't search topics |
| F-task-22 | 0.40.0 | Given ⌘K or the project picker, when I search, then recently touched items rank first | partial | palette ranking by recency not verified |
| F-task-23 | Unrel. | Given two tasks, when I tap ⌃Tab, then I'm back on the previous one; hold Ctrl and Tab to step through | built | `packages/shell/src/switcher/` |
| F-task-24 | 0.33.0 | Given split view, when I press [ or the sidebar button, then the list hides and the task takes the window | built | `shell.sidebar` shortcut in `builtins.tsx` |
| F-task-25 | 0.42.0 | Given the list head, when I click the round avatar, then account, Machines, Automations and Settings are there | partial | `SidebarHead`; Machines, Automations and account screens aren't mounted |
| F-task-26 | 0.18.0 | Given no folder, when I pick *No folder* and send, then the task runs without a project | built | `runtime.create` with no `cwd`; Home allows no project |
| F-task-27 | 0.21.0 | Given an API and a web repo, when I add a second folder, then one task works in both | partial | `StartArgs.dirs`, CLI `--also`; no GUI picker for extra folders |
| F-task-28 | 0.18.0 | Given a GitHub URL, when I paste it as a project, then wisp clones it (or reuses the clone) and adds it | partial | `git.clone` server + CLI; GUI project add not mounted |
| F-task-29 | Unrel. | Given a project in any picker, when I right-click it, then I can edit or remove it | partial | UI sends `project.update`, which no manifest lists (`docs/v2-sweep-commands.md`) |
| F-task-30 | 0.18.0 | Given 30 projects, when I look at the launcher's row, then chips stay on one row and the rest fold into More | partial | `ProjectChips.tsx`; overflow to More not verified (ADR-0012) |
| F-task-31 | 0.30.0 | Given an empty prompt box, when I press ↑, then my last sent prompt comes back (last 50) | partial | `plugins/shell-composer/ui/src/text/history.ts` exists, not mounted |
| F-task-32 | 0.30.0 | Given a half-typed prompt or follow-up, when wisp reloads or updates, then the text is still there | partial | drafts store in `@wisp/client`; Home keeps its text in a local signal |
| F-task-33 | 0.1.0 | Given a long task, when I press C or U, then turns collapse or I jump back to the top | missing | no C/U shortcut; no collapse-all |
| F-task-34 | 0.22.0 | Given a task, when I press V (or turn on *Full transcript*), then every tool call shows | partial | runtime keeps activity; `Transcript.tsx` is a stub |
| F-task-35 | 0.19.0 | Given a running task, when it runs a shell command, then the ticker says it in words (*Reading lines 15–50 of a.js*) | built | describe in `plugins/claude/core/src/describe.rs`; activity shown in `TaskView.tsx` |
| F-task-36 | Unrel. | Given a run quiet for 12 min, when I look at it, then it says *No output for 12 min* and keeps counting | missing | no quiet timer found |
| F-task-37 | Unrel. | Given wisp stopped, when 4 s pass, then the page says it lost wisp instead of *working* | built | `packages/shell/src/frame/PeerBanner.tsx` |
| F-task-38 | Unrel. | Given a reply sent while wisp doesn't answer, when it fails, then the text comes back to the box with a toast | partial | command rollback + toast in `@wisp/client`; follow-up text restore not verified |
| F-task-39 | 0.40.0 | Given two active tasks in one repo changing the same files, when I open one, then a note says so | built | `OverlapNote` in `TaskView.tsx`, `overlapsOf` in `rows-view.ts` |
| F-task-40 | 0.17.0 | Given a task, when I right-click → *Mention in prompt*, then a reference to it goes in the box | partial | task mentions parsed in `plugins/runtime/core`; composer `@`/mention UI not mounted |
| F-task-41 | 0.41.0 | Given an agent names one of my tasks, when its answer shows, then a `task` card opens it with a click | built | `packages/ui/src/blocks/Task.tsx` |
| F-task-42 | 0.43.0 | Given a task, when I fork it (⇧F), then a new task carries its conversation | partial | `runtime.fork` + GUI action; ⇧F key not registered |
| F-task-43 | 0.7.0 | Given a task, when I pick Rerun… (⇧R), then a dialog with the prompt, attachments, mode and harness reruns it | partial | `runtime.rerun` + GUI action; the editable dialog and ⇧R key not found |
| F-task-44 | 0.22.0 | Given the rerun dialog, when I pick another computer, then it reruns there | partial | `runtime.rerun` takes a pick; no GUI dialog |
| F-task-45 | 0.8.0 | Given a turn, when I click Restore, then the worktree goes back to its checkpoint | built | `git.restoreTurn`; `TaskView.tsx` restore action |
| F-task-46 | 0.43.0 | Given an open task, when I see its details column, then Mark done/Reopen, Ship it, Rerun, Fork and More are there | partial | `TaskDetails` actions; `TaskHead` stub; More lacks recipe/compare/share |
| F-task-47 | 0.3.0 | Given menus, when I read them, then they show key hints (⌘L on Mac, Ctrl+L elsewhere) | built | `displayCombo` in `packages/shell/src/keys.ts` |
| F-task-48 | 0.28.0 | Given a finished answer, when I open it again, then its entry animation doesn't replay | built | kit rule: entry animations once per mount (AGENTS.md); `Answer` kit |
| F-task-49 | 0.42.0 | Given a reply box open, when I click a suggestion or a button above it, then one click works | partial | needs the task page at parity |

## 2. Composer: New task and the reply box (`COMP`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-comp-1 | 0.3.0 | Given the launcher, when I open the harness · model picker, then harnesses with logos are left and models right, searchable | partial | `agentMenu` in `packages/shell/src/frame/pickers.ts`; `RunnerPicker.tsx` (searchable) not mounted |
| F-comp-2 | 0.43.0 | Given the picker, when I drag the thinking slider, then the level goes from Default to the harness's top | partial | effort is a `runtime.create` field; slider not mounted |
| F-comp-3 | 0.39.0 | Given Codex or Claude, when I open models, then they come from the CLI's own catalogue (Fable included) | built | `plugins/claude/host/src/lib.rs` catalogue (fable first), codex catalogue reader |
| F-comp-4 | 0.3.0 | Given the prompt, when I press Shift+Tab or the mode button, then it cycles Plan, Edits, Full auto | partial | `modeMenu` in Home and reply box; Shift+Tab not registered |
| F-comp-5 | 0.17.0 | Given a new task with no mode, when it launches (UI, API, CLI, triggers), then it's Full auto | built | runtime default mode |
| F-comp-6 | 0.14.0 | Given Auto, when I type, then the launcher shows what will run (*Opus · Medium*) and picks harness, model and effort | partial | `plugins/router` (`router.preview`, Auto pane); live pick label in the launcher not verified |
| F-comp-7 | 0.44.0 | Given Auto failed tests at low effort, when it retries, then it goes again at high before handing over | partial | router escalation rules exist; Auto checks (F-comp-8) were removed in v1 0.49 |
| F-comp-8 | 0.20.0 | Given Auto Best, when I enable *Best of two*, then two picks run and the better is marked | partial | router settings; compare runs missing (F-comp-30) |
| F-comp-9 | 0.11.0 | Given *Run on*, when I pick a computer, then the harness list shows that computer's harnesses | partial | `machines.recheckAgents`; GUI run-on picker not mounted |
| F-comp-10 | 0.45.0 | Given *Run on*, when I click a machine, then only it is picked and the menu closes | partial | as above |
| F-comp-11 | 0.8.0 | Given a git repo, when I launch with Worktree on, then the task runs in its own worktree on `wisp/<task>-<id>` from fresh `origin/main` | built | `plugins/worktrees` (`worktrees.create`, `ensure`); CLI `--no-worktree` |
| F-comp-12 | 0.3.0 | Given a file, when I drop or paste it next to the prompt box, then it's attached once (not opened) | partial | `StartArgs.attachments`, `stuff.upload`; Home has no drop target |
| F-comp-13 | 0.53.0 | Given the Android app, when I tap the paperclip, then Take photo / Record video / files are offered | missing | no v2 Android frontend (queue item 8) |
| F-comp-14 | 0.54.0 | Given the Android app, when I tap the mic, then what I say is typed in | missing | no dictation (only a model hint in `shell-composer`) |
| F-comp-15 | 0.51.0 | Given a project, when I type `@` and part of a file name, then matching files are offered | missing | no file index command; composer `@` not mounted |
| F-comp-16 | 0.40.0 | Given a prompt, when I type `@Ada`, then the task is Ada's job (a follow-up `@Ada` goes to her) | partial | `crew.wakeMentions`, runtime mentions; composer `@` picker not mounted |
| F-comp-17 | 0.49.0 | Given My Stuff, when I type `@` in a prompt, then kept items are offered and attached | partial | stuff mentions in runtime (round 4); picker not mounted |
| F-comp-18 | 0.43.0 | Given the prompt box, when I type `/`, then `/goal`, `/btw`, `/side`, `/sandbox`, `/terminal`, `/bug` and plugin commands show | partial | `shell-composer/ui/src/text/slash.ts` not mounted |
| F-comp-19 | 0.42.0 | Given a prompt starting *in 5 minutes…* or *remind me … in 1 hour*, when I send it, then it's held and starts then (or becomes a reminder) | partial | `later.add`, `later/core` time parsing; Home's `whenMenu`; text parsing on send not verified |
| F-comp-20 | 0.43.0 | Given an empty box, when I pick a time on the clock, then *Starts at …* shows under the box and Send holds it | partial | `whenMenu`/`whenAt` in Home; `TimeMenu.tsx` (later) not mounted |
| F-comp-21 | 0.43.0 | Given a schedule, when I type *every monday 9am*, then it reads it in plain words | built | `plugins/later/core/src/rules.rs`, ADR-0025 (jiff) |
| F-comp-22 | 0.51.0 | Given a prompt with `/draft` or *after #12*, when I send it, then it waits as a draft or starts after the other task | partial | `StartArgs.hold`, `runtime.release`, `runtime.held`; UI sends `session.held` (no manifest) |
| F-comp-23 | 0.3.0 | Given an agent is working, when I send a follow-up, then wisp interrupts and resumes with my message | built | `runtime.followUp`; `TaskView.tsx` reply box |
| F-comp-24 | 0.3.0 | Given a queued follow-up, when I click ×, then it's cancelled; drag reorders; Send now sends it | partial | `TaskFoot.tsx` (Send now, remove); `runtime.queue.order` reorder not mounted |
| F-comp-25 | 0.49.0 | Given queued follow-ups, when I press Stop, then they stay marked *Held after Stop* and nothing goes by itself | partial | `runtime.held`/`release`; `HeldCard` stub |
| F-comp-26 | 0.13.0 | Given a follow-up, when I switch mode or harness in the reply box, then the next turn uses it and the box names it | built | `runtime.setMode`, `runtime.setAgent`; `TaskView.tsx` pickers |
| F-comp-27 | 0.57.0 | Given a hand-off to another harness, when it continues, then my rules and effort go with it | partial | runtime hand-off in `runtime/core`; not verified end to end |
| F-comp-28 | 0.22.0 | Given a running task, when I type `/btw did you update the docs?`, then the agent answers on the side without stopping | partial | `runtime.btw`, `runtime.btw.drop`; reply-box `/btw` not mounted |
| F-comp-29 | 0.52.0 | Given a task, when I type `/side`, then a side discussion opens on its own page and can run commands in the task's folder | missing | UI sends `runtime.side`, no server command |
| F-comp-30 | 0.8.0 | Given the launcher, when I turn on vs and pick Codex and opencode, then the same task runs on each, shown as one task with a row per run and honest totals | partial | CLI `--compare` starts one task per harness (`crates/wisp/src`); no compare grouping, totals or GUI |
| F-comp-31 | Unrel. | Given a harness, when I click *Try it two ways*, then one task runs twice with one setting changed | missing | not found |
| F-comp-32 | 0.8.0 | Given the launcher, when I add subagents (a team), then the lead hands parts to other harnesses | built | `runtime.delegate`, `wisp_delegate` tool, `teamMenu` in Home and reply box |
| F-comp-33 | 0.34.0 | Given a task without a team, when I add subagents in a follow-up, then the next turn has them | built | `teamMenu` in `TaskView.tsx` |
| F-comp-34 | Unrel. | Given a task, when I pick many delegates, then there's no cap at 6 | partial | not verified |
| F-comp-35 | 0.51.0 | Given the launcher before my first task, when I look, then it's only prompt, mode, harness and Send | missing | no first-run variant in `HomeView.tsx` |
| F-comp-36 | 0.51.0 | Given New task, when I open *Issue*, then my GitHub, Linear and Jira issues are listed and one fills the prompt | partial | `issues.list` server; issues UI not mounted |
| F-comp-37 | 0.8.0 | Given a recipe `Prepare release {version}`, when I click it, then a dialog asks the fields and runs it | partial | `automations.tasks` (recipes as tasks), CLI `wisp recipes`; Recipes row not mounted |
| F-comp-38 | 0.51.0 | Given the harness picker, when I open it, then each harness shows how much of its plan is gone | partial | `accounts.limits`, budget; not in the picker |
| F-comp-39 | 0.43.0 | Given a task that would take my plan past the line, when I send, then wisp asks (Send anyway / wait for the reset) | partial | `budget.hold`, `later.waitAtLimit`; CLI `--yes`; GUI card not mounted |
| F-comp-40 | 0.16.0 | Given no harness on this computer, when I open the launcher, then *No coding agent here yet* offers to install opencode | partial | `accounts.install`; GUI setup card not mounted |
| F-comp-41 | 0.28.0 | Given a signed-out harness, when I pick it in Run with, then the sign-in opens right there | partial | `accounts.login.*`, `runtime.signIn`; GUI not mounted |
| F-comp-42 | Unrel. | Given a run fails because the harness is signed out, when I sign in from the turn, then wisp resends my request | partial | `runtime.signIn`/`signInDone`; `HaltCard` stub |
| F-comp-43 | 0.51.0 | Given I type in the launcher, when I press Enter, then the repo was already fetched (warm) so the agent starts at once | partial | `worktrees.ensure`; a warm-on-type call from the GUI not found |
| F-comp-44 | 0.18.0 | Given wisp starting, when the first frame paints, then the launcher is there (placeholders, not an empty strip) | built | `HomeView.tsx` renders before data (design/feedback.md) |
| F-comp-45 | Unrel. | Given Safari with an IME, when I press Enter to pick a word, then nothing is sent | built | keyCode 229 rule in `packages/shell/src/keys.ts` |
| F-comp-46 | Unrel. | Given Send from a finished task, when the row moves to Working, then the keyboard stays in the reply box | partial | not verified |

## 3. Task page: answers, questions, side panel (`PAGE`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-page-1 | 0.1.0 | Given an agent asks a question, when I click a choice or type, then it answers and the run goes on | built | `runtime.ask`/`answer`; `TaskFoot.tsx` renders the question and its choices |
| F-page-2 | 0.17.0 | Given Edits mode and a blocked tool, when I click Allow / Always / Deny, then the agent goes on (or not) | built | `runtime.approval`, `runtime.approveBlocked`; `TaskFoot.tsx` |
| F-page-3 | Unrel. | Given a question or approval, when I type in the reply box, then that's my answer (one box, not two) | partial | `TaskFoot.tsx` + reply box; the "reply denies the call" rule not verified |
| F-page-4 | 0.56.0 | Given a repo with hooks, MCP servers or setup, when a task first runs there (not Full auto), then wisp asks before trusting them | built | `worktrees.trust`, `worktrees.trust.pending`; GUI card not verified |
| F-page-5 | 0.8.0 | Given an `actions` block, when I click an item, then its command runs (or its reply is sent) | built | `packages/ui/src/blocks/Actions.tsx` |
| F-page-6 | 0.34.0 | Given answers with `app`, `doc`, `video`, `preview`, `map`, `graph`, `flow`, `chart`, `compare`, `stuff`, `task`, `blocked` blocks, when they show, then each renders | built | `packages/ui/src/blocks/*` (all 29 v1 block types have a renderer) |
| F-page-7 | 0.51.0 | Given Settings → *wisp blocks* off, when an agent answers, then it's plain markdown | partial | runtime prompt setting; GUI switch not found in General |
| F-page-8 | 0.49.0 | Given a quick question, when the agent answers, then it's plain text, not a report | built | runtime prompt (`plugins/runtime/core`), Markdown block |
| F-page-9 | 0.2.0 | Given a malformed `wisp` fence, when the turn ends, then the blocks are salvaged and raw text kept | built | fence parser in `plugins/runtime/core` |
| F-page-10 | 0.47.0 | Given an answer, when I select words or hover a block and click Comment, then the comment goes with my next follow-up | missing | no comment store or bubble |
| F-page-11 | Unrel. | Given unsent comments, when I open Ship it or Merge, then it says *2 comments not sent yet* | missing | depends on F-page-10 |
| F-page-12 | 0.57.0 | Given a finished turn, when I read its trail, then a receipt says *38k tokens · 71% cache · 3% of weekly* | partial | budget/claude parse receipts; `Receipt.tsx` stub |
| F-page-13 | 0.57.0 | Given Claude ran subagents, when I read the trail, then it says which and where the tokens went by model | partial | claude core parses `modelUsage`; no GUI |
| F-page-14 | Unrel. | Given a Claude task ≥100k tokens idle past its cache, when I reply, then a line warns the cache went cold | missing | no cold-cache check (only a gallery mock) |
| F-page-15 | Unrel. | Given a Claude task ≥200k tokens, when I pick *Compact now*, then the context shrinks | partial | `runtime.compact`; GUI action not found |
| F-page-16 | Unrel. | Given a task, when the CLI changed between turns, then *What changed* says version, tools, Codex models | partial | `runtime/host/src/setup.rs` changed-since; `WhatChanged.tsx` stub |
| F-page-17 | 0.56.0 | Given Claude refuses (usage policy), when the refusal card shows, then *Hand to …* moves the task to another harness | partial | refusal + hand-off in runtime core; `HaltCard` stub |
| F-page-18 | Unrel. | Given a Claude task, when I click *Run subagents on Haiku*, then built-in subagents use Haiku | partial | claude host option; offer not in GUI |
| F-page-19 | 0.46.0 | Given a task, when I press ] or the panel button, then a side panel opens with Changes, PR and Shell | partial | `SidePanel.tsx`: Changes works; PR and Shell show *later* |
| F-page-20 | 0.51.0 | Given Changes, when I open it, then every file changed since the base shows with a diff (first one open) | built | `git.changes`, `SidePanel.tsx` `Diff` |
| F-page-21 | 0.51.0 | Given Changes in a worktree, when I tick Stage and commit, then it commits | partial | `git.stage`, `git.commit` server; no GUI controls |
| F-page-22 | 0.51.0 | Given a hunk, when I click Revert (or tick Viewed), then that hunk or file goes back | partial | `git.revert` server; no GUI controls |
| F-page-23 | 0.51.0 | Given a diff line, when I comment on it, then the comment goes with the next follow-up | missing | see F-page-10 |
| F-page-24 | 0.51.0 | Given a changed file, when I click Edit, then it opens in wisp's editor and saves | missing | no editor screen; `lsp` plugin only answers queries |
| F-page-25 | 0.51.0 | Given the editor, when I hover or go to definition, then a language server answers (TS, Python, Go, Rust) | partial | `lsp.ask`, `lsp.install`; no editor UI |
| F-page-26 | 0.51.0 | Given Changes, when I click *Open file*, then any file of the task opens (search too) | missing | no file browser |
| F-page-27 | 0.46.0 | Given the side panel's Shell, when I type, then a login shell runs in the task's worktree (End shell keeps it ended) | partial | `terminal.shell.start`, `terminal.*`; Shell pane shows a placeholder |
| F-page-28 | 0.46.0 | Given a task's PR, when I open PR in the panel, then checks, reviews and merge state show without noise | partial | `ship.details`; PR pane placeholder; `PrStrip.tsx` shows the strip |
| F-page-29 | 0.51.0 | Given the side panel *Run*, when I click Run, then the task's app runs and its page shows beside the task (Logs, Restart) | partial | `runtime.projectRun`; no Run pane |
| F-page-30 | Unrel. | Given the preview, when I pick an element, then its HTML and styles go in the reply box | missing | no pick element |
| F-page-31 | 0.35.0 | Given a `preview` block, when it shows, then the live page is in the answer (cloud: the cloud's page) | built | `packages/ui/src/blocks/Preview.tsx`; grid proxy in `apps/grid` |
| F-page-32 | 0.50.0 | Given a long job, when the agent calls `wisp_watch`, then a live page shows beside the task | partial | `wisp_watch` tool in mcp core; no watch pane |
| F-page-33 | 0.29.0 | Given a task, when I press T (Take over), then the agent's session opens in a terminal inside wisp (or a terminal app/cmux) | partial | `terminal.open`, cmux in `terminal/core`, Settings terminal choice; T key and in-page terminal not mounted (rename to *Open in <harness>* queued) |
| F-page-34 | 0.51.0 | Given *Babysitting mode*, when I send a task, then it opens straight in the agent's own terminal | missing | not found |
| F-page-35 | 0.51.0 | Given `/terminal …`, when I send it, then the task runs in a terminal in wisp | missing | no `/terminal` |
| F-page-36 | 0.51.0 | Given `/sandbox`, when I send it, then the task runs in a fresh cloud box | partial | `grid-client.sandbox`; no slash entry |
| F-page-37 | 0.34.0 | Given a picture or video in an answer, when I click it, then it opens full screen and arrows go through them | partial | `Image.tsx`, `Video.tsx`; full-screen gallery not verified |
| F-page-38 | 0.32.0 | Given a picture in an answer, when I hover → Copy, then it pastes elsewhere | partial | not verified |
| F-page-39 | 0.34.0 | Given a picture, when I click *Show in folder*, then Finder/Explorer opens with it selected | partial | `stuff.reveal`; no GUI button |
| F-page-40 | 0.3.0 | Given an image an agent saved in `/tmp`, when I reboot, then it still shows (copied to `~/.wisp/shots`) | partial | stuff host keeps uploads; turn image copy not verified |
| F-page-41 | 0.55.0 | Given a `.env` in a diff or activity, when it shows, then values are hidden | partial | redaction code in several plugins; GUI masking not verified |
| F-page-42 | 0.13.0 | Given a finished turn, when I click 👍/👎, then feedback goes to the wisp team | partial | `telemetry.track`; button not found in the turn |
| F-page-43 | 0.45.0 | Given Home or `/bug`, when I click *Tell us*, then a feedback dialog sends a report | missing | no feedback dialog |
| F-page-44 | 0.30.0 | Given a task, when it lands while I'm reading it, then the view stays put (no jump to the new turn) | partial | not verified |

## 4. Goal and judges (`GOAL`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-goal-1 | 0.42.0 | Given *Done when …*, when a round ends unmet, then wisp sends the task back until the check passes | built | `goal.set`, `goal.check`, goal host; Home and reply box goal line |
| F-goal-2 | 0.51.0 | Given a running task, when I add a goal from the reply box, then it's checked from the next round | built | `setGoal` in `TaskView.tsx` |
| F-goal-3 | 0.51.0 | Given a goal, when I add up to five judges (harness, model, thinking), then each votes and the band shows votes | built | `plugins/goal/ui/src/Judges.tsx`, `Band.tsx` |
| F-goal-4 | Unrel. | Given a judge's vote, when I click it, then its check opens like a task with everything it said | partial | `RunView.tsx`, `Checks.tsx`; full transcript of the judge not verified |
| F-goal-5 | 0.42.0 | Given a goal, when I pause, resume or drop it, then the band follows and the reason stays after quit | built | `goal.pause`/`resume`/`drop` now in the manifest; band controls |
| F-goal-6 | 0.49.0 | Given Goal in the prompt box, when I send, then the Goal button lights while on and starts off next time | partial | Home goal toggle; reset-after-send not verified |
| F-goal-7 | 0.43.0 | Given `/goal …` right after a task lands, when sent, then the goal is checked | partial | `goal.set`; `/goal` slash not mounted |

## 5. Crew (`CREW`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-crew-1 | 0.40.0 | Given Crew → Add, when I give a name, role, brief and schedule, then a member exists and checks in on its clock | partial | `crew.create`, `crew.wake`, ADR-0043; no member editor in the GUI (`crew` UI registers nothing) |
| F-crew-2 | 0.40.0 | Given a member, when I build their spirit (body, glow, eyes, mouth, extra), then the face shows everywhere | partial | spirit in `crew/api`, kit `packages/ui/src/crew`; no builder mounted |
| F-crew-3 | 0.40.0 | Given a member, when I click them, then their thread fills the main pane with every job as a conversation | missing | no crew view registered (Sidebar navigates to `openCrew`, nothing renders it) |
| F-crew-4 | Unrel. | Given a wide window, when I look at the sidebar, then a rail shows each member's face; clicking filters the list to their jobs | partial | `CrewRail` in `Sidebar.tsx`; filtering the list by member not verified |
| F-crew-5 | Unrel. | Given the rail, when I hover a face, then a card shows name, role, status and tasks | partial | not verified in `CrewRail` |
| F-crew-6 | 0.40.0 | Given members, when they work, then a notebook keeps facts between jobs without filling context | built | crew core notebook; agents update via `wisp_crew_edit` |
| F-crew-7 | 0.40.0 | Given a member, when I open *Also starts when*, then it starts on events (PR opened, CI failed…) | built | `crew.wake` + triggers (ADR-0043) |
| F-crew-8 | 0.40.0 | Given any task, when I ask *add a crew member who reviews PRs hourly*, then it's added | built | `wisp_crew_add/edit/remove` tools (from members and subagents too, v1 0.55) |
| F-crew-9 | 0.40.0 | Given a member on another machine, when they get a job, then it runs there | partial | `crew.assign`, machines route; not verified end to end |
| F-crew-10 | 0.40.0 | Given a member, when I edit *Skills and instructions*, then their own skills and AGENTS.md go with each job | partial | `crew.kit`; `KitSection.tsx`, `KitEditor.tsx` exist but aren't mounted |
| F-crew-11 | 0.43.0 | Given a delegated crew job, when I click its row in the lead's team panel, then the job opens | partial | delegations recorded; team panel not mounted |
| F-crew-12 | 0.41.0 | Given a member or the whole crew, when I click Share, then a `.crew.json` or link is made; dropping one imports it | partial | `crew.export`, `crew.import`; GUI not mounted |
| F-crew-13 | 0.43.0 | Given a member, when I pick *See what X used*, then their usage and what ate my limits show | partial | `crew.stats`; no GUI |
| F-crew-14 | 0.49.0 | Given the Org page, when I drag cards, then the chart keeps my layout | partial | `crew.graph`, `crew.layout`/`set_layout`; no Org page |
| F-crew-15 | Unrel. | Given a member's job that asks me something, when I look at the list, then it's in Needs you with their face | partial | list includes crew jobs; face on row not verified |
| F-crew-16 | 0.42.0 | Given the Crew section, when nobody is busy, then two members stay and the rest fold (busy first) | partial | rail only; no compact Crew section |
| F-crew-17 | 0.40.0 | Given a member's check-in, when it schedules a follow-up and finds nothing, then the follow-up still comes | built | `later.agent.schedule` (resume_later) |
| F-crew-18 | 0.40.0 | Given the API, when I `POST` a job or check-in, then the member runs it | built | `crew.assign`, `crew.checkin`; CLI `wisp crew …` |
| F-crew-19 | 0.40.0 | Given a member's kit, when it builds its own, then the kit is saved | partial | `crew.kit`; UI sends `crew.localKit` (no manifest) |
| F-crew-20 | Unrel. | Given a member's finished job, when its toast or notification is clicked, then that job opens | partial | notifications not mounted |

## 6. Automations, triggers, schedules (`AUTO`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-auto-1 | 0.8.0 | Given Automations → Triggers, when I add a cron schedule, then a task starts on time | partial | `automations.task.set`, trigger sources (ADR-0043), CLI `wisp trigger`; Automations screen not mounted |
| F-auto-2 | 0.8.0 | Given a *CI failed* trigger, when a GitHub Actions run fails, then a task starts (or follows up the branch's task) | built | `github` trigger sources; follow-up on the same branch in automations host |
| F-auto-3 | 0.51.0 | Given Slack, Linear, Sentry, PagerDuty or a webhook trigger, when it fires, then a task starts | partial | `automations.trigger.push`, webhook source; Sentry/PagerDuty/Linear kinds not verified |
| F-auto-4 | Unrel. | Given a Slack trigger with `users`, when someone not listed posts, then nothing starts | partial | not verified |
| F-auto-5 | 0.42.0 | Given a task, when I type *in 10 min check again* in the reply box, then the follow-up goes then | partial | `later.add`; reply-box time parse not verified |
| F-auto-6 | 0.42.0 | Given scheduled items, when I look at the list, then a Scheduled section holds tasks, reminders and check-ins | partial | `later.list`; Scheduled section in list not verified |
| F-auto-7 | 0.49.0 | Given a waiting item, when I click Edit, then I change its text or time before it goes | partial | `later.edit`; GUI not mounted |
| F-auto-8 | 0.56.0 | Given an agent scheduled a check-in, when its task finishes, then it moves from Needs you to Scheduled | partial | `later.agent.schedule`; list placement not verified |
| F-auto-9 | 0.42.0 | Given a plan near the limit, when work would pass it, then it waits for the reset and goes after | built | `budget.hold`, `later.waitAtLimit` |
| F-auto-10 | 0.51.0 | Given *Automations stop at* per harness, when usage passes it, then automations wait | partial | `budget.setStop`; no Usage pane |
| F-auto-11 | Unrel. | Given low free memory or high CPU, when a check-in or trigger is due, then it waits | built | `machine` guard (round 4), `machine.automations.pause` |
| F-auto-12 | 0.51.0 | Given a banked Codex reset lands early, when it does, then waiting work goes | partial | budget core; not verified |
| F-auto-13 | 0.20.0 | Given a PR conflicts, when I click *Fix conflicts*, then a follow-up resolves it (auto-fix off unless set) | built | `ship.fix_conflicts`; `PrStrip.tsx` |
| F-auto-14 | 0.18.0 | Given *Auto-fix PR conflicts* on, when main moves, then wisp fixes shipped PRs itself | partial | ship host auto-fix; GUI switch not found |
| F-auto-15 | 0.8.0 | Given a webhook URL in config, when a task finishes or asks, then wisp POSTs it | partial | webhook delivery in automations/runtime; config UI not mounted |
| F-auto-16 | 0.25.0 | Given a spell, when I cast *a floating button that opens my PRs*, then wisp changes itself | dropped | ADR-0031 (spells gone, plugins replace them) |
| F-auto-17 | 0.41.0 | Given a spell with `crew`, when installed, then its members join | dropped | ADR-0031; formulas carry crew (ADR-0026) |

## 7. Worktrees (`WT`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-wt-1 | 0.51.0 | Given `.worktreeinclude`, when a worktree is made, then ignored files listed are copied (copy-on-write on a Mac) | built | `plugins/worktrees/core` + host |
| F-wt-2 | Unrel. | Given a repo with `.conductor/settings.toml`, when a task starts, then its setup runs | built | conductor support in worktrees core/host |
| F-wt-3 | Unrel. | Given Conductor worktrees, when I open the project, then *Bring in* lists them | partial | `worktrees.bringIn` in manifest; `BringIn.tsx` in the Worktrees pane; topic `plugin:wisp.worktrees:worktrees` had no writer (sweep) |
| F-wt-4 | Unrel. | Given I mark a task done, when it has a worktree, then wisp asks to remove it (and its delegates') | partial | `worktrees.done.list`/`apply`; dialog in GUI not verified |
| F-wt-5 | Unrel. | Given old worktrees, when the hourly sweep runs, then merged/closed and old Done ones go, under a cap | built | `worktrees.sweep`, `worktrees.clean` |
| F-wt-6 | Unrel. | Given Settings → Worktrees, when I open it, then I see every worktree with Keep and Remove | built | `plugins/worktrees/ui/src/panes/Worktrees.tsx` |
| F-wt-7 | Unrel. | Given a task archived right after it finishes, when its worktree is clean, then it's removed | partial | not verified |

## 8. Ship, PR, review (`SHIP`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-ship-1 | 0.8.0 | Given a finished worktree task, when I click Ship it (S), then it commits, pushes and opens a PR | built | `ship.ship`; `ShipButton.tsx`, `ShipDialog.tsx`; CLI `wisp ship <id>`; S key not registered |
| F-ship-2 | 0.10.0 | Given nothing to ship, when the task finishes, then Ship it doesn't show | partial | not verified |
| F-ship-3 | 0.38.0 | Given Ship it, when I click it, then the dialog opens at once and shipping happens in the background | built | `ShipDialog.tsx` + `ShipRun.tsx` (pending state) |
| F-ship-4 | 0.30.2 | Given a PR, when I click Merge, then it confirms and merges | built | `ship.merge`; `MergeConfirm.tsx`; CLI `wisp merge` |
| F-ship-5 | 0.20.0 | Given a PR with running checks, when they change, then the PR state updates faster | built | `ship.refresh`, `ship.recheck` |
| F-ship-6 | 0.44.0 | Given agents open PRs, when they call `wisp_pr`, then the PRs attach to the task | built | `ship.attach`, `wisp_pr` tool |
| F-ship-7 | 0.45.0 | Given a task's PR merged, when more changes are made, then Ship it comes back | partial | not verified |
| F-ship-8 | 0.56.0 | Given *Review by another harness* on, when a PR is open, then another harness reviews before Merge (sees what I ruled out, says if partial) | partial | `review.maybe`, `review.view`; General has the setting; UI sends `ship.review` (not in manifest) |
| F-ship-9 | 0.30.2 | Given a PR conflict, when I see the PR row, then Fix conflicts is last, in the same place | built | `PrStrip.tsx` |

## 9. My Stuff, apps and panes (`STUFF`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-stuff-1 | 0.49.0 | Given an agent's picture, doc or file, when I click Save to My Stuff, then it's on the My Stuff page | partial | `stuff.save`, `wisp_save`; My Stuff UI not mounted (ADR-0036) |
| F-stuff-2 | 0.49.0 | Given an agent saves with `wisp_save`, when it does, then a `stuff` card shows in the answer | built | `packages/ui/src/blocks/Stuff.tsx`, `wisp_save` |
| F-stuff-3 | 0.49.0 | Given a kept item, when an agent saves with its id, then a v2 appears in place | built | `stuff.update`, `stuff.restore` |
| F-stuff-4 | 0.49.0 | Given an app folder, when it's saved, then Launch opens it in wisp | partial | `stuff.launch`, `stuff.stop`; no GUI |
| F-stuff-5 | 0.50.0 | Given `"db": true`, when the app runs, then it keeps data (seed.sql once, no 5 s cut on a slow disk) | built | per-app SQLite (ADR-0020), `stuff.resetData` |
| F-stuff-6 | 0.50.0 | Given an app, when I click Publish, then it's at a grid link; secrets and source maps stay off | partial | `stuff.publish`/`unpublish`, `stuff.setPublished`; no GUI; secret filtering not verified |
| F-stuff-7 | Unrel. | Given *make me a pane that…*, when I send it, then an agent builds a pane and it pins beside tasks or on Home | partial | `stuff.starters`, `addStarter`, panes model in `stuff/ui/src/panes`; not mounted |
| F-stuff-8 | Unrel. | Given a pane, when it asks for `tasks:write`, then it can only propose a prompt, loses access when code changes, and can't grow during Full auto | partial | `stuff.grant`, `stuff.allow`; enforcement not verified |
| F-stuff-9 | Unrel. | Given Agent board and Allowance board starters, when I add one, then it shows tasks and periods | partial | starters exist; no GUI |
| F-stuff-10 | 0.50.0 | Given the phone app via wisp Cloud, when I open My Stuff, then I can launch apps | missing | no phone frontend |

## 10. Sharing (`SHARE`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-share-1 | 0.51.0 | Given a task, when I pick Share…, then it's on my wisp Grid at a link anyone can open | partial | `share.create`, `share.preview` (ADR-0032, 0038); `ShareDialog.tsx` exists in stuff UI, not mounted |
| F-share-2 | 0.51.0 | Given a share link, when I import it, then the task is in my list | built | `share.import`, `runtime.import`, CLI `wisp share` |
| F-share-3 | 0.51.0 | Given a share, when I stop it, then the link stops working | partial | `share.stop`, `grid-client.revoke`; no My shares screen |
| F-share-4 | Unrel. | Given a phone share sheet (Android), when I share a link or PDF to wisp, then New task opens with it attached | missing | no Android frontend |

## 11. Machines, cloud and the grid (`MACH`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-mach-1 | 0.9.0 | Given another computer over SSH, when I add it in Machines, then agents run there | partial | `machines.add`, `connect`, ADR-0010; Machines UI not mounted |
| F-mach-2 | 0.10.0 | Given `~/.ssh/config` and Tailscale, when I open Machines, then found hosts are listed | partial | `machines.discover`, `machines.hosts`; no GUI |
| F-mach-3 | 0.27.0 | Given a machine that doesn't know my key, when I click *Let me in*, then my password once installs it | partial | `machines.letIn`; no GUI |
| F-mach-4 | 0.27.0 | Given a machine with only SSH, when I add it, then wisp installs Node and itself there | partial | v2 ships a binary; install over SSH not verified |
| F-mach-5 | 0.11.0 | Given a machine on an older wisp, when I click *Update to X*, then it restarts on this version | missing | no remote update command |
| F-mach-6 | 0.22.0 | Given any project, when I pick a machine, then it runs there; a follow-up can move the task to another computer | partial | `machines.route`; GUI run-on not mounted |
| F-mach-7 | 0.38.0 | Given another machine, when I delegate to it, then the delegate runs there and says where | partial | `machines.call`; not verified |
| F-mach-8 | 0.27.0 | Given Settings → Machines → This computer, when I check, then it says whether SSH answers here | partial | `machines.reachable`; no GUI |
| F-mach-9 | 0.28.0 | Given Settings → Cloud, when I sign in to a wisp Grid with a code, then my cloud computer joins | partial | `grid-client.signin`, CLI `wisp login`; Cloud pane not mounted |
| F-mach-10 | 0.37.0 | Given a terminal, when I run `wisp computer on`, then this computer is on my grid | built | `crates/wisp/src/cloud_cli.rs` `computer` |
| F-mach-11 | 0.34.0 | Given my computers on the grid, when I open the grid's account page, then each is listed with Open and state | built | `apps/grid/src` account page |
| F-mach-12 | 0.28.0 | Given `wisp grid serve`, when people sign in (GitHub, Google, OIDC), then each gets their own wisp | built | `apps/grid`, CLI `wisp grid` (round 2) |
| F-mach-13 | 0.37.0 | Given a busy host, when someone signs in, then the grid admits by memory and waitlists the rest | built | `apps/grid` admit, `wisp grid waitlist` |
| F-mach-14 | 0.29.0 | Given my grid account, when I type my handle and delete, then the account and box are gone | built | `apps/grid` account deletion |
| F-mach-15 | Unrel. | Given an API key, when I call `https://<handle>.<domain>/api/…` with `Bearer wgk_…`, then it works without a browser | partial | `wgk_` in `apps/grid`; key management UI not verified |
| F-mach-16 | 0.44.0 | Given a computer on the grid, when I open a preview from my phone, then its localhost page shows | built | grid tunnel previews in `apps/grid` |
| F-mach-17 | 0.51.0 | Given `/sandbox`, when I run it, then a fresh box runs the task and I can remove it | partial | `grid-client.sandbox`, `sandboxes`, `sandboxRemove`; GUI not mounted |
| F-mach-18 | 0.28.0 | Given Settings → Cloud, when I click Sign in for Claude on a cloud computer, then I sign in its agents from my desktop | partial | accounts login runs on any peer; no Cloud pane |
| F-mach-19 | Unrel. | Given Settings → This Mac, when I open it, then I see free memory, CPU, disk, each task's RAM/CPU, harness folders, leftover processes with Stop | built | `plugins/machine/ui/src/MachinePage.tsx`; `machine.load`/`read`/`stop`/`fix`/`harness.clean` |
| F-mach-20 | Unrel. | Given a grid, when I open it after sign-in, then a real home page shows (not one long column) | built | `apps/grid/src` (v1 change; v2 grid has the account page) — parity not checked |
| F-mach-21 | 0.47.0 | Given several grids or accounts, when I add an account, then each is listed | partial | `grid-client.teams`; desktop UI not mounted |

## 12. Channels: phone, chat, mail (`CHAN`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-chan-1 | 0.8.0 | Given ntfy set up, when a task finishes or asks, then my phone gets it; tapping an option answers (no repeat after restart) | built | `plugins/ntfy`, `channels.notify`, `channels.act` |
| F-chan-2 | 0.13.0 | Given a Telegram bot, when I message it, then a task starts; replying to a question answers it | built | `plugins/telegram` (round 4), `channels.inbound` |
| F-chan-3 | Unrel. | Given *Say what you'd type in wisp* on, when I send `@ada in api on laptop with opus high plan: …`, then it reads like the launcher | partial | channels grammar queued (`docs/v2-queue.md` coverage sweep) |
| F-chan-4 | Unrel. | Given a forwarded Telegram message, when it arrives, then it doesn't run as my words | partial | not verified |
| F-chan-5 | Unrel. | Given Slack two-way, when I set it up from the manifest, then threads start tasks and buttons answer questions (linked people only) | partial | `plugins/slack` transport; grammar and buttons wait on the channels grammar |
| F-chan-6 | Unrel. | Given Discord, when I use `/wisp`, then a task starts and replies come back | partial | `plugins/discord`; grammar pending |
| F-chan-7 | Unrel. | Given a GitHub comment starting `/wisp …` on my repo, when posted, then a task starts and answers there | partial | `plugins/github` transport; grammar pending |
| F-chan-8 | Unrel. | Given a secret mail address on the grid, when I mail it, then a task starts from the subject | partial | `plugins/email`; grid mail in coverage sweep |
| F-chan-9 | Unrel. | Given a sleeping cloud wisp, when Telegram/Slack/Discord posts, then the grid holds it, wakes the box and delivers once | partial | `channels.routed`; grid inbox listed as a known gap |
| F-chan-10 | Unrel. | Given a channel-started task, when it runs, then it stays at Edits or lower and says when it stalls on me | partial | not verified |
| F-chan-11 | Unrel. | Given a report with a token in it, when it goes to a channel, then the secret is redacted | built | redaction in `plugins/channels/api` |
| F-chan-12 | 0.27.0 | Given Settings → Notifications, when a task finishes or asks, then a desktop notification shows | partial | `Notifications.tsx` pane; `shell-home/ui/src/notify.ts` not mounted |
| F-chan-13 | 0.8.0 | Given Settings → Phone, when I open it, then one dialog sets up ntfy, Telegram, Slack, Discord, GitHub and email | partial | `channels.view`/`update`/`test`; Phone dialog not mounted (Notifications links to it) |

## 13. Connectors and MCP (`CONN`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-conn-1 | 0.42.0 | Given Settings → Connectors, when I add an MCP server once, then every harness's tasks get it | partial | connectors core/host injects servers; manifest lists **0 commands**, UI sends `connectors.add/update/remove/test/signin/signout/import` that no manifest lists |
| F-conn-2 | 0.42.0 | Given a remote connector (PostHog, Linear), when I click Sign in, then OAuth replaces pasting a token | partial | `wisp_connector_signin` tool; no command |
| F-conn-3 | 0.42.0 | Given a task, when I ask *add PostHog*, then the agent adds the connector | built | `wisp_connector_add` tool |
| F-conn-4 | 0.6.0 | Given Claude Code or Codex, when I run `wisp mcp`, then wisp's MCP tools (launch, wait, get, reply, list, stop, agents…) work | built | `plugins/mcp` (`mcp.rpc`, `mcp.tools`), CLI `wisp mcp` |
| F-conn-5 | 0.6.0 | Given an agent, when I run `wisp skill install --agent claude`, then the wisp skill is installed | built | CLI `skill` in `args.rs` |
| F-conn-6 | 0.17.0 | Given a task, when I ask *which tools do my tasks use?*, then `wisp_stats` answers | built | `wisp_stats` in mcp core |
| F-conn-7 | 0.50.0 | Given a task, when I ask *have codex review this*, then the agent drives wisp (launch, delegate) | built | `wisp_launch`, `wisp_delegate` tools |
| F-conn-8 | Unrel. | Given Plan mode in Claude Code, when the agent asks or tags, then wisp's tools still work | partial | not verified |
| F-conn-9 | 0.25.0 | Given Codex in Edits or Plan, when it calls wisp's tools, then they aren't refused | partial | codex host flags; not verified |

## 14. Agents, accounts, usage (`ACCT`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-acct-1 | 0.3.0 | Given Claude Code, Codex, opencode, Cursor, Antigravity, Grok, Copilot installed, when I launch, then each runs headless with its mode flags | built | `plugins/{claude,codex,opencode,cursor,antigravity,grok,copilot}` |
| F-acct-2 | 0.28.0 | Given Settings → Agents, when I click Sign in, then the CLI's own login runs with its link and code | partial | `accounts.login.*`; Agents pane not mounted |
| F-acct-3 | 0.42.0 | Given two plans for Claude Code or Codex, when I add a second account, then tasks can pick it | partial | `accounts.add`, `StartArgs.account`; no GUI |
| F-acct-4 | 0.37.0 | Given opencode Zen/Go, when I paste the API key, then opencode runs on it | partial | `accounts.keys.set`; no GUI |
| F-acct-5 | 0.12.0 | Given Settings → Agents → Re-check, when I click it, then harnesses and models are found again (all machines) | partial | `accounts.recheck`, `machines.recheckAgents`; no GUI |
| F-acct-6 | 0.24.0 | Given a missing harness, when I look in Agents, then a one-line install for my OS shows | partial | `accounts.install`; no GUI |
| F-acct-7 | 0.24.0 | Given only the Codex or Claude desktop app, when I launch, then wisp uses their bundled CLI | partial | not verified in harness hosts |
| F-acct-8 | 0.54.0 | Given a harness's program changed, when wisp runs it, then it says so | built | `runtime/host/src/setup.rs` changed-since |
| F-acct-9 | 0.8.0 | Given Settings → Usage, when I open it, then spend, turns, success by project and harness · model show | partial | `budget.view`; Usage pane not mounted |
| F-acct-10 | 0.42.0 | Given Plan budget, when I open it, then each account's 5-hour and weekly windows show, with banked Codex resets | partial | `budget.view`, `accounts.limits`; no GUI |
| F-acct-11 | 0.43.0 | Given usage reports, when windows move, then wisp shares the change out among tasks (*Where your plan went*) | partial | budget core; no GUI |
| F-acct-12 | 0.51.0 | Given *Drain watch* on, when an account drains fast, then wisp warns | partial | budget drain; no GUI |
| F-acct-13 | 0.55.0 | Given a window changes length or reset, when wisp reads it, then it says so | partial | budget events; no GUI |
| F-acct-14 | 0.57.0 | Given two accounts, when I open Usage, then tokens per model per account show | partial | budget core; no GUI |
| F-acct-15 | 0.54.0 | Given Codex says 429 with room left, when it does, then wisp tells limits apart | built | codex host/budget |
| F-acct-16 | 0.57.0 | Given Codex *model at capacity* in Auto, when it happens, then Auto moves on | partial | router; not verified |
| F-acct-17 | 0.7.0 | Given finished tasks, when they go quiet, then a retro learns preferences and lessons, shown in Memory | missing | `plugins/learn` has no commands (29-line host) |
| F-acct-18 | 0.14.0 | Given Settings → Auto, when I set goal, allowed harnesses and best-of-two, then Auto follows | built | `plugins/router/ui/src/AutoPane.tsx`, `router.set` |

## 15. Settings (`SET`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-set-1 | 0.8.0 | Given Settings, when I open it, then it's a sidebar of panes (General, Notifications, Agents, Auto, Usage, Memory, Automations, Phone, Machines, Cloud, Connectors, This Mac) with the X pinned | partial | Settings frame mounted with General, Notifications, Keys, Auto, Updates, Worktrees; Agents, Usage, Memory, Automations, Phone, Machines, Cloud, Connectors panes missing (This Mac is a page) |
| F-set-2 | 0.31.0 | Given General → Theme, when I pick System, Light or Dark (or ⌘K), then the theme switches | built | `shell.theme` setting, `Appearance.tsx` |
| F-set-3 | 0.32.0 | Given General → Terminal, when I pick in-wisp, Auto-detect or an app, then Take over uses it | built | `General.tsx` terminal setting |
| F-set-4 | 0.8.0 | Given General → Editor, when I pick one, then Open in editor uses it | built | `General.tsx` editor setting |
| F-set-5 | 0.8.0 | Given General → Worktree per task, when I turn it off, then tasks run in the repo | partial | worktree setting in manifest; switch not found in General |
| F-set-6 | 0.28.0 | Given the Android app, when I look for shortcuts, then the shortcuts sheet is hidden | partial | platform detection exists; no Android frontend |
| F-set-7 | 0.30.0 | Given Windows, when settings save while a file is held, then it retries instead of failing | partial | settings store in `crates/wisp/src/settings_store.rs`; retry not verified |
| F-set-8 | — | Given Settings → Keys, when I open it, then shortcuts are listed | built | `plugins/shell-settings/ui/src/panes/Keys.tsx` |

## 16. Keyboard (`KEY`, from `web/js/features/keys.js`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-key-1 | 0.3.0 | Given anywhere, when I press ⌘K or ⌘L, then the palette opens or the launcher gets focus | built | `builtins.tsx` |
| F-key-2 | 0.3.0 | Given the list, when I press N, then New task opens | built | `shell.new` |
| F-key-3 | 0.16.0 | Given a menu open, when I press Esc, then only it closes | built | `shell.escape` |
| F-key-4 | 0.3.0 | Given anywhere, when I press ?, then the shortcuts sheet opens | built | `shell.help`, `Shortcuts.tsx` |
| F-key-5 | 0.3.0 | Given a focused task, when I press J/K, then focus moves down/up; O or Enter opens | missing | not registered |
| F-key-6 | 0.3.0 | Given a focused task, when I press E, A, L, M, Delete, then done, archive, for later, rename, delete | missing | not registered (actions exist via menus) |
| F-key-7 | 0.8.0 | Given a focused task, when I press S, ⇧R, ⇧F, T, V, D, P, ], /, then ship, rerun, fork, take over, transcript, changes, PR, panel, reply | missing | not registered (TaskView shows ⇧R/T/V as hints only) |
| F-key-8 | 0.8.0 | Given a long feed, when I press U/Home or C, then back to top or collapse all | missing | not registered |
| F-key-9 | Unrel. | Given the desktop app, when I press Ctrl+` , then the terminal toggles | missing | `ctrl+\`` reserved in `BUILT_IN_KEYS`, no handler |
| F-key-10 | Unrel. | Given ⌃Tab, when tapped or held, then the switcher | built | see F-task-23 |

## 17. CLI and integrations (`CLI`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-cli-1 | 0.6.0 | Given a terminal, when I run `wisp "fix the test" --wait --json`, then the task runs and prints its result | built | `crates/wisp/src` launch options |
| F-cli-2 | 0.6.0 | Given tasks, when I run `wisp ls --state=review`, `show`, `wait`, `reply`, `stop`, then they work (a bad state errors) | built | `COMMANDS`, `LS_STATES` in `args.rs` |
| F-cli-3 | 0.8.0 | Given a task, when I run `wisp ship <id>` or `wisp merge`, then it ships or merges | built | `args.rs` |
| F-cli-4 | 0.8.0 | Given `--compare codex,opencode:model`, when I launch, then it runs on each | partial | one task per harness, no grouping (see F-comp-30) |
| F-cli-5 | 0.6.0 | Given the JS SDK `WispClient`, when I script launch/wait/reply, then it works | dropped | ADR-0031 drops the v1 SDK shapes; a TS and Python SDK on v2 are listed as gaps in `docs/v2-queue.md` |
| F-cli-6 | 0.6.0 | Given `GET /api/openapi.json`, when I fetch it, then the API is described | built | ADR-0019, route table |
| F-cli-7 | 0.6.0 | Given v1's HTTP routes, when a script calls them, then they work | dropped | ADR-0031 (v2 has `/api/cmd` only) |
| F-cli-8 | 0.6.0 | Given `~/.wisp/server.json`, when a tool reads it, then it finds the server | built | discovery in `crates/wisp/src/client.rs` |
| F-cli-9 | 0.2.0 | Given `npx wisp-agents`, when I run it, then the desktop app (or `--browser`) opens | partial | `--browser`, `desktop` command; no desktop app yet (F-desk-1) |
| F-cli-10 | — | Given any plugin, when I run `wisp <plugin> <verb>`, then that command runs (help, completions) | built | `plugin_cmd.rs`, ADR-0022 |
| F-cli-11 | 0.6.0 | Given an old `~/.wisp`, when I run `wisp import`, then tasks, crew and settings come over once | built | `v1_formula.rs`, ADR-0031 |

## 18. Desktop app (`DESK`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-desk-1 | 0.2.0 | Given a Mac, Windows or Linux, when I open wisp.app, then wisp opens in its own window (Tauri, a third of Electron's size) | missing | no `apps/desktop`; queue item 8 |
| F-desk-2 | 0.37.0 | Given a release, when I download, then there's a .dmg, Windows installer and Linux package | missing | waits on F-desk-1 |
| F-desk-3 | 0.38.0 | Given `curl … install.sh \| bash -s -- --app`, when I run it, then the Mac app installs without the warning | partial | `docs/install.sh` is v1's; v2 app missing |
| F-desk-4 | 0.2.1 | Given the app, when I right-click text, then spelling, copy link, cut/copy/paste show | missing | waits on F-desk-1 |
| F-desk-5 | Unrel. | Given a slow `~/.zshrc`, when the app first opens, then the window shows within 5 s | missing | waits on F-desk-1 |
| F-desk-6 | 0.35.0 | Given the app with no task open, when I drag the top, then the window moves | missing | waits on F-desk-1 |

## 19. Phone app and phone web (`PHONE`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-phone-1 | 0.27.0 | Given the Android app, when I add a computer over SSH, then wisp opens on it | missing | no v2 Android frontend (ADR-0031: v2 bundles only; queue item 8) |
| F-phone-2 | 0.27.0 | Given the app in the background, when a task finishes or asks, then an Android notification shows; tapping opens the task | missing | as above |
| F-phone-3 | 0.47.0 | Given the app's list, when I swipe right/left, then mark done / save for later | missing | no swipe in `shell-list` |
| F-phone-4 | 0.51.0 | Given a task page, when I swipe left, then the side panel comes in | missing | |
| F-phone-5 | 0.28.0 | Given wisp Cloud, when I sign in from the app (GitHub/Google), then my cloud wisp and computers are listed | missing | |
| F-phone-6 | 0.57.0 | Given iPhone Safari on my cloud wisp, when I Add to Home Screen, then it runs full screen | partial | service worker in `apps/web/src/worker.ts`; manifest not verified |
| F-phone-7 | 0.42.0 | Given a browser under 900 px, when I tap a task, then it opens as its own page | partial | `nav.layout`; not at parity |
| F-phone-8 | 0.51.0 | Given 4,000 tasks on a bad connection, when I use the app, then it stays quick | partial | perf budgets (ADR-0011) exist; not measured on phone |

## 20. Updates, install, telemetry (`UPD`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-upd-1 | 0.7.0 | Given a newer wisp, when I open wisp, then an Update button shows and Update now updates however I installed it, on the same port | partial | `update.check`/`install`/`view`, Updates pane; relaunch is a known gap |
| F-upd-2 | 0.38.0 | Given the update channel, when I pick beta or nightly, then I follow it (semver prerelease order) | built | `plugins/update/core` |
| F-upd-3 | 0.16.0 | Given Homebrew or the curl line, when I install, then wisp installs | partial | npm launcher in `npm/`; brew tap and install.sh still v1 |
| F-upd-4 | 0.5.0 | Given telemetry on, when I use wisp, then anonymous stats and errors go to PostHog (off switch) | partial | `telemetry.track/set/flush`; some events missing (queue) |

## 21. Look and feel (`LOOK`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-look-1 | 0.43.0 | Given any screen at 320–1440 px, light and dark, when I compare with v1, then it looks the same | partial | kit reproduces v1 values; `qa/parity.mjs` 0/96 views pass |
| F-look-2 | 0.42.0 | Given toasts, when several come, then they stack as light cards with a glyph | built | kit toaster |
| F-look-3 | 0.41.0 | Given a working task, when I look, then the dot-grid ripple shows | built | kit `core` working indicator (parity pending) |
| F-look-4 | 0.33.0 | Given the app, when I look at the logo, then it's the handwritten w with the orb | partial | not verified in v2 assets |
| F-look-5 | 0.39.0 | Given control text (buttons, pills, tabs), when the window narrows, then nothing wraps and bars collapse to icons then More | partial | ADR-0012 kit; `qa/layout.mjs` not passing on all views |

---

## Appendix: v1 `web/js/features/*` modules and where their rows are

| Module | Rows |
|---|---|
| accounts, agent-login, api-keys, usage, budget | F-acct-*, F-mach-15 |
| actions, spell-actions | F-page-5 |
| after-pick, runner-picker, runners, places, place-menu | F-comp-1…10 |
| attachments | F-comp-12…13 |
| auto, auto-preview | F-comp-6…8, F-acct-18 |
| automations, watch | F-auto-*, F-page-32 |
| bring-in, clones, worktrees, done-folders | F-wt-*, F-task-28 |
| btw, side | F-comp-28…29 |
| cache | F-page-14…15 |
| changes, editor, compare | F-page-20…26, F-comp-30 |
| cloud, getapp, sign-in-card, reachable, machine, machines, homescreen | F-mach-*, F-phone-6 |
| commands, slash, mentions, composer, reply-send, queued, hold | F-comp-*, F-task-40 |
| comment-store, comments | F-page-10…11, F-page-23 |
| connectors | F-conn-* |
| crew, crew-kit, crew-record, crew-share, org, team, lineage | F-crew-* |
| dictate | F-comp-14 |
| fab, phone, panel-swipe, swipe | F-phone-* |
| feed, split, project-list, projects, scroll, switcher, theme, tips, launcher | F-task-*, F-set-2 |
| feedback | F-page-42…43 |
| goal, goal-run, judges | F-goal-* |
| harness-watch | F-acct-8, F-page-16 |
| issues | F-comp-36 |
| keys | F-key-* |
| later | F-task-10, F-auto-5…8 |
| live, transcript, turns, plan-view | F-task-34…35, F-page-12 |
| memory | F-acct-17 |
| notify, reconnecting | F-chan-12, F-task-37 |
| overlaps | F-task-39 |
| pane-card, pane-make, panes, stuff | F-stuff-* |
| panel, term, term-view | F-page-19, F-page-27, F-page-33 |
| run, sandbox, sandbox-browser | F-page-29…30, F-page-36, F-mach-17 |
| settings | F-set-* |
| setup | F-comp-40, F-task-25 |
| share, share-in | F-share-* |
| ship | F-ship-* |
| spells, spell-ui | F-auto-16…17 (dropped) |
| update | F-upd-1 |
