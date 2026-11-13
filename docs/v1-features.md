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
| F-task-4 | 0.40.0 | Given the list, when I click *Needs you*, *Crew* or *Working* (or Tab + Enter), then that section folds | built | every section's heading folds on click, Enter or Space (kit `FoldHead`, role button, aria-expanded), kept across reloads (`toggleSection`, the view store); test `fold-head.test.tsx`; seen in Chrome (Working folds and unfolds, Needs you stays folded after a reload); round 37 |
| F-task-5 | 0.24.0 | Given more than 60 done tasks, when I scroll Done, then its count is the real total and older ones load | partial | list renders; no `VirtualList`/paging found in `shell-list` (AGENTS.md requires it past 200 rows) |
| F-task-6 | 0.48.0 | Given a task row, when I read it, then a third line names harness logo, model and where it ran | partial | `RowParts.tsx` draws rows; parity of the third line not reached |
| F-task-7 | 0.3.0 | Given a task, when I right-click it, then a menu offers open, rename, mark done, for later, archive, delete, rerun, fork, mention | built | round 30: v1's whole taskMenu on a row's right-click, in v1's order and words: the list's own (Open, Rename, Copy task ID, Save for later, Mark done, Archive, Delete) and what plugins attach to `shell.row:menu` (contract `bar.keys`/`text`/`place`, additive): Rerun… ⇧R, Fork… ⇧F, Side discussion…, Share…, Ship it… S, Changes, Shell, Run app, Save as recipe…, Add to crew… / Open <member>, Set goal… (and the goal's others), Keep worktree; it picks its row and slides to fit (v1 clampToViewport); `menu.test.ts`, `row-menu.test.ts`. Mention: the @ menu (F-comp-16) |
| F-task-8 | 0.3.0 | Given a task, when I press A (or Archive), then it moves to Archived and a new question brings it back | built | A on the picked row or the open task, the menu's Archive (`task-keys.test.ts`, round 26); a new question brings it back: the follow-up's optimistic patch un-archives the row at once, the runtime does it when the run starts (and on a question it asks); tests `queue-reply.test.ts` `…_v1_unarchive_on_reply`, host `lifecycle.rs` `a_new_question_brings_an_archived_task_back_v1_unarchive_on_reply` (round 39) |
| F-task-9 | 0.45.0 | Given a task, when I rename it (M, Enter saves, Esc cancels), then I stay on the task | built | M opens the title for editing (the page's `onKey` → `split.title`), Enter keeps it, Esc leaves it; `task-keys.test.ts` (round 26: checked) |
| F-task-10 | 0.43.0 | Given a done task, when I press L (or swipe left on phone), then it's parked under For later; L again unparks | built | L on the open task toggles For later (`onKey` → `runtime.forLater`); the phone's swipe left (shell-list `TaskRow` DEFAULT_SWIPE `later`) (round 26: checked) |
| F-task-11 | 0.43.0 | Given the open task, when I mark it done, archive or delete it, then wisp goes to the next task that needs me (feed) or New task | built | `TaskView.tsx` after Mark done / archive / delete opens `nextNeedsYou` (the newest in Needs you, not archived, not a subagent's), else Home; test `leaving_a_task_opens_the_next_that_needs_you_else_new_task`; seen in Chrome (Mark done → the next task); round 19 (2026-11-12) |
| F-task-12 | 0.39.0 | Given a running task, when I delete it, then it's gone without flashing through Needs you or notifying | built | `runtime.delete` stops the run first (`plugins/runtime/host/src/ops.rs`) |
| F-task-13 | 0.39.0 | Given a task a recipe or trigger started, when I see its row, then it has a bolt (recipe) or the trigger's mark | built | the row's mark (`plugins/shell-list/ui/src/model/row.ts` markOf: a bolt for a recipe, the trigger's mark, v1 feed.js originMark), round 32 `origin-mark.test.ts` |
| F-task-14 | Unrel. | Given a task that crashed, hit a limit or was refused, when I see its row, then the pill says which | partial | the turn's limit card (`turn.limit`): Wait until the reset (`later.add`), Carries on at …, the other harnesses, Get extra usage; the refusal card (F-page-17); the row's pill still shows the state only; round 14 (2026-11-11) |
| F-task-15 | Unrel. | Given a new task, when its first answer lands, then the task keeps a name from what I asked, not the agent's headline | built | The first answer names the task from what was asked (the hero's `topic`, or a quick answer's `presentation.topic`), never the hero's title; Compare runs keep the prompt's title (v1 `!session.groupId`, missing in v2: fixed in `finish.rs`); test `lifecycle.rs` `the_first_answer_names_the_task_after_what_was_asked_but_never_a_compare_run_v1_task_naming` (fails without the fix) (round 39) |
| F-task-16 | 0.32.0 | Given an open task, when I reload or copy the address, then `#/s/<id>` opens the same task | built | `browserHistory` in `@wisp/client`; navigation is URL-backed |
| F-task-17 | 0.32.0 | Given I scrolled a task, when I reload and open it again, then I'm back where I was | built | each task keeps its place (`frame/place.ts`, the `shell.places` store, 100 kept): held by the turn at the top (`TurnView` `data-turn`) or the end, saved on switching tasks and when the page hides, restored on opening (after the store loads); test `place.test.ts`; seen in Chrome across a task switch and a reload (round 38) |
| F-task-18 | 0.31.0 | Given I opened a task before, when I open it again, then it shows at once from cache | built | IndexedDB persist in `@wisp/client` (ADR-0006) |
| F-task-19 | 0.3.0 | Given many tasks, when I press ⌘K and type, then a fuzzy search finds tasks, projects and commands | built | `packages/shell/src/palette/` |
| F-task-20 | 0.51.0 | Given past work, when I type 3+ letters in ⌘K, then it finds words inside prompts and answers | built | ⌘K's tasks source has `deep` (`pastWork`, `packages/shell/src/builtins.tsx`): three letters or more ask `runtime.search` (FTS), each hit a task with the words found, after what's listed by title; test `past-work.test.ts`; seen in Chrome ("forwarded" finds the rate-limit task by its answer); round 35 |
| F-task-21 | 0.43.0 | Given agents tagged tasks (`wisp_tag`), when I search a topic, then tagged tasks match | built | ⌘K's tasks carry their topics (runtime `tags`, set by `wisp_tag`): `#auth` or the word finds them (`tagsOf` + the palette's tag rank); test `task-topics.test.ts` (round 38) |
| F-task-22 | 0.40.0 | Given ⌘K or the project picker, when I search, then recently touched items rank first | built | ⌘K ranks by match, recency breaking ties (`packages/shell/src/palette/match.ts` `rank`/`recency`, `palette.test.ts` 'recency breaks ties'); ⌘P lists projects recent first (`frame/project-switch.ts`) |
| F-task-23 | Unrel. | Given two tasks, when I tap ⌃Tab, then I'm back on the previous one; hold Ctrl and Tab to step through | built | `packages/shell/src/switcher/` |
| F-task-24 | 0.33.0 | Given split view, when I press [ or the sidebar button, then the list hides and the task takes the window | built | `shell.sidebar` shortcut in `builtins.tsx` |
| F-task-25 | 0.42.0 | Given the list head, when I click the round avatar, then account, Machines, Automations and Settings are there | partial | `SidebarHead`; Machines, Automations and account screens aren't mounted |
| F-task-26 | 0.18.0 | Given no folder, when I pick *No folder* and send, then the task runs without a project | built | `runtime.create` with no `cwd`; Home allows no project |
| F-task-27 | 0.21.0 | Given an API and a web repo, when I add a second folder, then one task works in both | partial | `StartArgs.dirs`, CLI `--also`; no GUI picker for extra folders |
| F-task-28 | 0.18.0 | Given a GitHub URL, when I paste it as a project, then wisp clones it (or reuses the clone) and adds it | built | Projects (kit `ProjectsSheet`, round 30, v1's layout): a GitHub URL turns Add into Clone (`git.clone`), then the project is added; parity projects 0 parts off in the dialog |
| F-task-29 | Unrel. | Given a project in any picker, when I right-click it, then I can edit or remove it | built | the Projects dialog (`packages/shell/src/frame/Projects.tsx`, `shell.projects`): rename in place, a colour, Remove, each a `project` resource op shown at once; tests `projects_read_from_their_rows_in_your_order_…`, `a_new_projects_name_comes_from_its_folder_or_url_…`; seen in Chrome 1440 light, 390 dark; round 17 (2026-11-11) |
| F-task-30 | 0.18.0 | Given 30 projects, when I look at the launcher's row, then chips stay on one row and the rest fold into More | built | top-bar chips, New task's row and its Other folder… list, shell-list's (Toolbar folds into More), all in your order (`runtime.projectOrder`, #772), dragged or Alt+←/→ (kit `reorderable`); test `a_dragged_or_alt_moved_item_lands_before_the_one_it_was_dropped_on_…`; seen in Chrome (drag, reload); round 17 |
| F-task-31 | 0.30.0 | Given an empty prompt box, when I press ↑, then my last sent prompt comes back (last 50) | built | ↑ in an empty box (Home or a reply) brings back the last prompt sent, ↑ again the one before, ↓ forward (`prompt-keys.ts`, the `shell.sent` store, 50 kept, across reloads); test `prompt-keys.test.ts`; seen in Chrome after a reload; round 34 |
| F-task-32 | 0.30.0 | Given a half-typed prompt or follow-up, when wisp reloads or updates, then the text is still there | built | New task's text and each reply are drafts (`packages/shell/src/frame/drafts.ts`: `<home>:launcher` → text, the key wisp.stuff's share-in already wrote to and Home ignored; a task's key → reply), in the client's drafts store (persisted, flushed when the page hides); test `drafts.test.ts` (a reload on the same disk); seen in Chrome: both still there after a reload; round 37 |
| F-task-33 | 0.1.0 | Given a long task, when I press C or U, then turns collapse or I jump back to the top | built | C and U (F-key-8); round 13 (2026-11-11) |
| F-task-34 | 0.22.0 | Given a task, when I press V (or turn on *Full transcript*), then every tool call shows | built | `shell/src/frame/TurnTranscript.tsx` on the kit's `Timeline` (v1 transcript.js renderTranscript): the head with its counts, each step on the rail (an edit's +/−, a command, an error's output behind a chevron), the agent's message (the presentation's notes), where it ended; the hero gets its state row and meta back, the receipt drops its counts, Transcript shows pressed; test `a_heros_state_row_is_left_out_on_a_tasks_latest_answer_and_back_with_the_transcript`; parity task.transcript 1440 15 of 149 parts off (from 30); round 20 (2026-11-12) |
| F-task-35 | 0.19.0 | Given a running task, when it runs a shell command, then the ticker says it in words (*Reading lines 15–50 of a.js*) | built | describe in `plugins/claude/core/src/describe.rs`; activity shown in `TaskView.tsx` |
| F-task-36 | Unrel. | Given a run quiet for 12 min, when I look at it, then it says *No output for 12 min* and keeps counting | built | `noOutputLine` (`packages/shell/src/frame/no-output.ts`): the working panel's note says *No output for 12 min* (then *1 h 5 min*) on a running turn with no step since, cleared by a step, a question, a working delegate or an open subagent call; test `no-output.test.ts`; round 34 |
| F-task-37 | Unrel. | Given wisp stopped, when 4 s pass, then the page says it lost wisp instead of *working* | built | `packages/shell/src/frame/PeerBanner.tsx` |
| F-task-38 | Unrel. | Given a reply sent while wisp doesn't answer, when it fails, then the text comes back to the box with a toast | built | a refused follow-up puts its text back (`TaskView.tsx` send: `.catch` → `setText(v)`, the comments' `back()`), New task's too (`setText(prompt)`), and the client's onError shows the toast; with drafts (F-task-32) the text also survives a reload while it's back; round 37 |
| F-task-39 | 0.40.0 | Given two active tasks in one repo changing the same files, when I open one, then a note says so | built | `OverlapNote` in `TaskView.tsx`, `overlapsOf` in `rows-view.ts`; its × (v1 #787) closes it per task until what it says changes (`overlap-dismiss.ts`, tests `overlap-dismiss.test.ts`) |
| F-task-40 | 0.17.0 | Given a task, when I right-click → *Mention in prompt*, then a reference to it goes in the box | built | v1's way (Copy task ID, then paste): a paste that is only task ids becomes their mentions (`@Title`), sent as `@[Title](wisp:id)` (`prompt-menu.ts` `pastedTasks`, both boxes); test `prompt-menu.test.ts` `…_v1_paste_task_id`; seen in Chrome (round 38) |
| F-task-41 | 0.41.0 | Given an agent names one of my tasks, when its answer shows, then a `task` card opens it with a click | built | `packages/ui/src/blocks/Task.tsx` (live title/state via the frame's `answerContext`, Open); test `answer_blocks_that_act_draft_reply_run_and_allow_through_the_host_as_v1_did`; round 12 (2026-11-11); until then the renderer was a stub drawing "Unknown block" |
| F-task-42 | 0.43.0 | Given a task, when I fork it (⇧F), then a new task carries its conversation | built | ⇧F on the open task (`onKey` → More's Fork, `runtime.fork`) (round 26: checked) |
| F-task-43 | 0.7.0 | Given a task, when I pick Rerun… (⇧R), then a dialog with the prompt, attachments, mode and harness reruns it | built | Rerun… (every entry: row menu, More, the toolbar's harness menu, ⇧R) opens v1's dialog (`frame/Rerun.tsx`): the prompt to edit, mode, harness · model picker, Rerun → a new task from the task's spec (`runtime.spec`, `rerun.ts` → `runtime.create` with `lineage.rerunOf`); the menu's Rerun used to send copy args to `runtime.rerun` (a turn retry): fixed; test `rerun.test.ts`; seen in Chrome (round 38) |
| F-task-44 | 0.22.0 | Given the rerun dialog, when I pick another computer, then it reruns there | built | Rerun…'s Run on lists the computers (this one, as where it ran, and the others) when there's more than one; the new task is made on the one picked; test `rerun.test.ts` `…_v1_rerun_elsewhere` (round 38); round 39: on another computer it runs as v1 did (places.js): the folder's origin is asked here (`git.origin`), that computer finds its checkout (its projects, then the usual folders) or clones it (`git.checkout`), adds it to its projects, and the task runs in the same subfolder there; no origin says v1's words; tests `run-on.test.ts` `…_v1_run_on_place`, `…_v1_run_on_no_origin`, git `real_git.rs` `…_v1_run_on_checkout`, `mock-computers.test.ts` `…_v1_run_on_mock` (Studio in the mock: `?seed=computers`) |
| F-task-45 | 0.8.0 | Given a turn, when I click Restore, then the worktree goes back to its checkpoint | built | `git.restoreTurn`; `TaskView.tsx` restore action |
| F-task-46 | 0.43.0 | Given an open task, when I see its details column, then Mark done/Reopen, Ship it, Rerun, Fork and More are there | built | `TaskDetails` actions; More in v1's order (round 31) with Merge PR #n… and Review PR #n (round 32), Watch and Compare runs (round 33) |
| F-task-47 | 0.3.0 | Given menus, when I read them, then they show key hints (⌘L on Mac, Ctrl+L elsewhere) | built | `displayCombo` in `packages/shell/src/keys.ts` |
| F-task-48 | 0.28.0 | Given a finished answer, when I open it again, then its entry animation doesn't replay | built | kit rule: entry animations once per mount (AGENTS.md); `Answer` kit |
| F-task-49 | 0.42.0 | Given a reply box open, when I click a suggestion or a button above it, then one click works | partial | needs the task page at parity |
| F-task-50 | Unrel. | Given a task with wisp subagents, when I open it on a desktop, then its details show its plan share with theirs added and how full its context is, and a click shows all of it | built | v1 #785: the runtime sums the row (`usage_row.rs`: `tokens`, `context`, `plan`, `subUsage`, `usage`; runtime-core `task_usage.rs`), the claude parser reports the context window; kit `TaskUsage` in `TaskDetails` (wide pane only, as v1); tests `…_v1_785` in claude `context_window.rs`, runtime-core `task_usage.rs`, runtime host `usage_row.rs`, shell `task-usage.test.ts`, kit `task-usage.test.tsx`; mock `?seed=usage` |

## 2. Composer: New task and the reply box (`COMP`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-comp-1 | 0.3.0 | Given the launcher, when I open the harness · model picker, then harnesses with logos are left and models right, searchable | built | `RunnerPicker.tsx` in New task and now the reply box (the pick goes with the next follow-ups as `run`, test `the_reply_boxs_harness_model_pick_goes_with_the_next_follow_up_and_none_keeps_the_tasks_own`), harness logos in its list (kit `RadioOption.logo`); round 15 (2026-11-11) |
| F-comp-2 | 0.43.0 | Given the picker, when I drag the thinking slider, then the level goes from Default to the harness's top | built | the picker's Thinking is v1's slider (kit `ThinkingSlider`, v1 .pk-think values: fill, motes, stops, orb knob): Default on the left to the harness's top, drag previews and release commits, arrows/Home/End step; test `think.test.tsx`; seen in Chrome light and dark (round 38) |
| F-comp-3 | 0.39.0 | Given Codex or Claude, when I open models, then they come from the CLI's own catalogue (Fable included) | built | `plugins/claude/host/src/lib.rs` catalogue (fable first), codex catalogue reader |
| F-comp-4 | 0.3.0 | Given the prompt, when I press Shift+Tab or the mode button, then it cycles Plan, Edits, Full auto | built | Shift+Tab in Home's box and the reply box cycles Plan → Edits → Full auto (`prompt-keys.ts` `promptKeys`, kits' `onKey`); test `prompt-keys.test.ts`; seen in Chrome; round 34 |
| F-comp-5 | 0.17.0 | Given a new task with no mode, when it launches (UI, API, CLI, triggers), then it's Full auto | built | runtime default mode |
| F-comp-6 | 0.14.0 | Given Auto, when I type, then the launcher shows what will run (*Opus · Medium*) and picks harness, model and effort | built | `frame/auto.ts` + HomeView: `router.preview` after a 300 ms pause, the chip shows v1's short label (GPT-5.6-Terra · High) with "Auto will run …: why", New task sends `agent: auto` so the router routes it, `autoOverride` when you pick your own (tests `picking_your_own_harness_after_autos_preview_tells_auto_what_it_had_shown`, `a_routed_rows_logo_says_why_auto_picked_it_as_v1_did`); seen in Chrome against the real router (the answer takes ~7.5 s: backend note); round 14 (2026-11-11); a click on the pick opens v1's popover (round 29: kit `AutoPop`, why, odds, Worth a try, Or run, Never pick … for … tasks with Undo, How Auto picks), asked at once on Home as v1 |
| F-comp-7 | 0.44.0 | Given Auto failed tests at low effort, when it retries, then it goes again at high before handing over | partial | router escalation rules exist; Auto checks (F-comp-8) were removed in v1 0.49 |
| F-comp-8 | 0.20.0 | Given Auto Best, when I enable *Best of two*, then two picks run and the better is marked | partial | router settings; compare runs missing (F-comp-30) |
| F-comp-9 | 0.11.0 | Given *Run on*, when I pick a computer, then the harness list shows that computer's harnesses | built | New task's harness · model picker asks the picked computer (`RunnerPicker peer`), so it lists that computer's harnesses; Run on sets it (`frame/where.ts`); test `where.test.ts` (round 38) |
| F-comp-10 | 0.45.0 | Given *Run on*, when I click a machine, then only it is picked and the menu closes | built | Run on lists this computer first and the others after, the picked one checked; a pick makes it the one place and the menu closes; the launch goes there; test `where.test.ts` `…_v1_run_on` (one computer in the mock: the list itself not seen with two) (round 38); round 39: on another computer it runs as v1 did (places.js): the folder's origin is asked here (`git.origin`), that computer finds its checkout (its projects, then the usual folders) or clones it (`git.checkout`), adds it to its projects, and the task runs in the same subfolder there; no origin says v1's words; tests `run-on.test.ts` `…_v1_run_on_place`, `…_v1_run_on_no_origin`, git `real_git.rs` `…_v1_run_on_checkout`, `mock-computers.test.ts` `…_v1_run_on_mock` (Studio in the mock: `?seed=computers`) |
| F-comp-11 | 0.8.0 | Given a git repo, when I launch with Worktree on, then the task runs in its own worktree on `wisp/<task>-<id>` from fresh `origin/main` | built | `plugins/worktrees` (`worktrees.create`, `ensure`); CLI `--no-worktree` |
| F-comp-12 | 0.3.0 | Given a file, when I drop or paste it next to the prompt box, then it's attached once (not opened) | built | `packages/shell/src/frame/attach.ts`: picked, pasted (a screenshot named as v1 did) or dropped on the reply box or New task (they light up), each uploads at once (`POST /uploads` through `client.http(peer)`), the prompt carries the attachments (`runtime.followUp` / `runtime.create`); test `pasted_and_dropped_files_become_chips_and_go_up_to_the_tasks_computer_as_its_attachments`; seen in Chrome (drop → upload 201 → chip); round 13 (2026-11-11) |
| F-comp-13 | 0.53.0 | Given the Android app, when I tap the paperclip, then Take photo / Record video / files are offered | missing | no v2 Android frontend (queue item 8) |
| F-comp-14 | 0.54.0 | Given the Android app, when I tap the mic, then what I say is typed in | missing | no dictation (only a model hint in `shell-composer`) |
| F-comp-15 | 0.51.0 | Given a project, when I type `@` and part of a file name, then matching files are offered | built | the reply box's @ offers the task's files (`worktrees.files`, shell-composer `fileItems`): ↵ inserts `@path`, Open (⌘↵) shows it in the file view; test `a_tasks_files_in_the_at_menu_insert_their_path_and_open_in_the_file_view`; seen in Chrome; round 17 (New task's @ needs a project's files: not yet); New task's @ offers the picked project's files too (`worktrees.files {path}`, only your projects' folders), seen in Chrome; round 18 |
| F-comp-16 | 0.40.0 | Given a prompt, when I type `@Ada`, then the task is Ada's job (a follow-up `@Ada` goes to her) | built | the @ menu (contract `PromptSourceDef`, shell-composer `prompt.ts`) offers crew members; picked, sent as `@[Ada](crew:ada)` (`frame/prompt-menu.ts encodeMentions`); tests `the_at_menu_names_tasks_crew_and_stuff_…`, `a_prompt_box_opens_its_menu_…`; round 13; a reply that starts with `@Ada` goes to her as `crew.ask` (crew-ui's prompt source `send`), her answer under that turn with Reply (`crew.reply`, the same job), tests `a_reply_to_a_members_answer_lands_right_under_its_thread_…`, `a_reply_starting_with_crew_members_goes_to_them_…`; seen in Chrome (1440 light, 390 dark: asked, answered, replied in the thread); round 16 (2026-11-11) |
| F-comp-17 | 0.49.0 | Given My Stuff, when I type `@` in a prompt, then kept items are offered and attached | built | the @ menu offers My Stuff items, sent as `@[Title](stuff:id)`; see F-comp-16; round 13 (2026-11-11) |
| F-comp-18 | 0.43.0 | Given the prompt box, when I type `/`, then `/goal`, `/btw`, `/side`, `/sandbox`, `/terminal`, `/bug` and plugin commands show | built | the / menu: the reply box's commands and New task's (v1 slash-text.js words), seen in Chrome; /spell no longer offered (ADR-0031); round 13 (2026-11-11) |
| F-comp-19 | 0.42.0 | Given a prompt starting *in 5 minutes…* or *remind me … in 1 hour*, when I send it, then it's held and starts then (or becomes a reminder) | built | a time the prompt starts with ("in 5 min …", "tomorrow at 9 …") holds it, "remind me … in 1 hour" makes a reminder: wisp.later's `later.launch` prompt source on New task (`launch.ts`, `parseWhen`) → `later.plan`; test `launch.test.ts`; seen in Chrome (Scheduled) (round 38) |
| F-comp-20 | 0.43.0 | Given an empty box, when I pick a time on the clock, then *Starts at …* shows under the box and Send holds it | built | a time picked on New task's clock goes with Send (`LaunchPick.at`, additive) and the task is held until then (`later.plan`), the chip and Send's label as before; test `launch.test.ts` `…_v1_clock_pick`; seen in Chrome (round 38) |
| F-comp-21 | 0.43.0 | Given a schedule, when I type *every monday 9am*, then it reads it in plain words | built | `plugins/later/core/src/rules.rs`, ADR-0025 (jiff) |
| F-comp-22 | 0.51.0 | Given a prompt with `/draft` or *after #12*, when I send it, then it waits as a draft or starts after the other task | built | `/draft …` waits in Drafts, `/after <task> …` (a mention, an id or a link) starts once that task is done, its row says *After “…” is done*; test `launch.test.ts` `…_v1_draft_after`, shell-list `…_v1_after_row`; seen in Chrome (round 38) |
| F-comp-23 | 0.3.0 | Given an agent is working, when I send a follow-up, then wisp interrupts and resumes with my message | built | `runtime.followUp`; `TaskView.tsx` reply box |
| F-comp-24 | 0.3.0 | Given a queued follow-up, when I click ×, then it's cancelled; drag reorders; Send now sends it | built | the queue over the reply box (shell-composer QueueFoot/QueueList): drag or ↑/↓ on the grip reorders (`runtime.queue.order`), × / Cancel asks then cancels, Send now, Edit, Combine; v1's Queue switch in the reply bar (`composer.queueSwitch`, Settings `runtime.followUp`); a queued reply goes in the queue at once (`followUp` `queue`, `queuedOps`). Root causes fixed: QueueFoot never mounted (shell-composer's store id `wisp.shell-composer.sent` was refused, then its settings were 'declared twice' because `client.plugin(id)` made a new client each call: now one per plugin while its scope lives). Tests `queue-reply.test.ts`, shell-composer `env.test.ts`, `queue.test.ts`, client `plugin_clients_are_one_per_plugin…`; seen in Chrome (round 38) |
| F-comp-25 | 0.49.0 | Given queued follow-ups, when I press Stop, then they stay marked *Held after Stop* and nothing goes by itself | built | a Stop keeps the queue, held: the first row says *Held after Stop*, the rest *Queued #n*, nothing goes by itself (runtime `a_stop_holds_the_queue…`); Stop's question says so; test `queue.test.ts` `…_v1_queue_held_after_stop`; seen in Chrome (round 38) |
| F-comp-26 | 0.13.0 | Given a follow-up, when I switch mode or harness in the reply box, then the next turn uses it and the box names it | built | `runtime.setMode`, `runtime.setAgent`; `TaskView.tsx` pickers |
| F-comp-27 | 0.57.0 | Given a hand-off to another harness, when it continues, then my rules and effort go with it | partial | runtime hand-off in `runtime/core`; not verified end to end |
| F-comp-28 | 0.22.0 | Given a running task, when I type `/btw did you update the docs?`, then the agent answers on the side without stopping | built | `/btw …` in the reply box asks on the side (`runtime.btw`), shown at once as answering (optimistic entry), the answer lands under the turns (`BtwList`: tag, Markdown answer, wait dots, error, ×), × drops it (`runtime.btw.drop`); mock answers after 1.5 s; test `queue-reply.test.ts` `…_v1_btw`; seen in Chrome (round 39) |
| F-comp-29 | 0.52.0 | Given a task, when I type `/side`, then a side discussion opens on its own page and can run commands in the task's folder | built | `/side` and a row's Side discussion…: `runtime.create` with the task as parent (shell-composer `side`), shown at once as a pending task under it |
| F-comp-30 | 0.8.0 | Given the launcher, when I turn on vs and pick Codex and opencode, then the same task runs on each, shown as one task with a row per run and honest totals | built | `wisp --compare a,b` gives its runs one group (`ext["wisp.runtime"].group`, the row's `groupId`: `plugins/runtime/host/src/group.rs`); a run's More and right-click offer Compare runs (`shell.row.compare`), which opens the Compare dialog (`packages/shell/src/frame/Compare.tsx`, kit `CompareRuns`): the ask, a table (Time, Cost, Tokens, Cache, Agent steps, Files, Tests, Asked; `compare.ts`), the sentence against run A, each run's answer, Open card, Keep this (asks, archives the others, deletes their worktrees). Tests `compare.test.ts` (2), `a_run_of_a_compare_carries_its_group_on_the_row_v1_compare_group`; seen in Chrome at 1440 and 390. Left: the launcher's vs toggle (the CLI starts compares), v1's Plan row (plan-window shares), the feed showing a compare as one task; round 33; round 34: the launcher's vs + (kit `LauncherCompare`; `nextRun`, `MAX_RUNNERS` 4; each run behind a "vs ×", its own harness menu; the lead is run A, the runs share a `groupId` through `runtime.create`'s `ext`), and the Plan row (`planShares`: a run alone shows its share of its longest window, runs overlapping on one account split the total by cost, as an estimate; the totals line), fed by wisp.budget writing each turn's shares to `ext["wisp.budget"].plan` (it now begins and ends turns in its ledger; test `two_turns_on_one_account_share_the_move_by_time_v1_budget_sharers`). Tests `compare.test.ts` 4. Left: the feed folding a compare into one task; round 35: the list folds a compare into one card as v1's .task-item (a `list.compare` group box behind the head and its runs; the head's *vs Compare* opens Compare runs, kit `Button mark`); test `a compare task is one card` in `flat.test.ts` |
| F-comp-31 | Unrel. | Given a harness, when I click *Try it two ways*, then one task runs twice with one setting changed | missing | not found |
| F-comp-32 | 0.8.0 | Given the launcher, when I add subagents (a team), then the lead hands parts to other harnesses | built | `runtime.delegate`, `wisp_delegate` tool, `teamMenu` in Home and reply box |
| F-comp-33 | 0.34.0 | Given a task without a team, when I add subagents in a follow-up, then the next turn has them | built | `teamMenu` in `TaskView.tsx` |
| F-comp-34 | Unrel. | Given a task, when I pick many delegates, then there's no cap at 6 | built | No cap: eight delegates picked are eight sent (`teamRows`) and eight in the prompt; tests `team.test.ts` `…_v1_no_team_cap`, runtime core `eight_delegates_stay_eight_no_cap_at_six_v1_no_team_cap` (round 39) |
| F-comp-35 | 0.51.0 | Given the launcher before my first task, when I look, then it's only prompt, mode, harness and Send | built | `first-run.ts` (`firstRunOf`, `firstRunTools`, the `shell.launcherFull` store): until your first task Home's bar is attach, mode, harness and Send, with More options for the rest; opened once, or a task of yours, and it stays full; test `first-run.test.ts`; round 34 |
| F-comp-36 | 0.51.0 | Given New task, when I open *Issue*, then my GitHub, Linear and Jira issues are listed and one fills the prompt | built | `plugins/issues/ui` (`issues.picker` overlay from New task's Issue button): `issues.list` per source, filtered as you type and searched on the peer, Other sources / Connect Linear… / Jira… (connectors-ui `exampleFor`, `isFor`), fills the prompt through `ShellContext.prompts` with Undo; test `the_issue_picker_lists_a_sources_issues_offers_the_others_or_connect_and_writes_the_prompt`; seen in Chrome (No folder: the peer's Pick a project note); round 14 (2026-11-11) |
| F-comp-37 | 0.8.0 | Given a recipe `Prepare release {version}`, when I click it, then a dialog asks the fields and runs it | partial | `automations.tasks` (recipes as tasks), CLI `wisp recipes`; Recipes row not mounted |
| F-comp-38 | 0.51.0 | Given the harness picker, when I open it, then each harness shows how much of its plan is gone | partial | `accounts.limits`, budget; not in the picker |
| F-comp-39 | 0.43.0 | Given a task that would take my plan past the line, when I send, then wisp asks (Send anyway / wait for the reset) | built | Settings → Usage: Ask near the limit (`budget.limitHold` off/80/90/95), Wait for the reset (`runtime.limitWait`), Check Codex while work waits (`budget.liveLimits`), v1's words; plus the turn's limit card (round 14); round 15 (2026-11-11) |
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
| F-page-5 | 0.8.0 | Given an `actions` block, when I click an item, then its command runs (or its reply is sent) | built | `packages/ui/src/blocks/Actions.tsx` + `run-result.tsx` over `runtime.exec` (exit code, output, Send failure to agent; confirm in place); test `answer_blocks_that_act_draft_reply_run_and_allow_through_the_host_as_v1_did`; round 12 (2026-11-11); until then the renderer was a stub drawing "Unknown block" |
| F-page-6 | 0.34.0 | Given answers with `app`, `doc`, `video`, `preview`, `map`, `graph`, `flow`, `chart`, `compare`, `stuff`, `task`, `blocked` blocks, when they show, then each renders | built | every v1 block type renders (`packages/ui/src/blocks/*`, v1 CSS in `answer-content.css`/`answer-rich.css`): app (sandboxed, saved state via `runtime.appState`, offers to send), doc (opening, Read all, Full screen, Copy), preview (device frames, rotate, reload, sandboxed), map (numbered pins, pick, Route, Open in Google Maps), graph (lanes, merge target, numbered conflicts, action); test `map_doc_preview_graph_and_app_blocks_render_and_act_as_v1s_did`; gallery PNGs r13-{map,preview,graph,app}-*; round 13 (2026-11-11) |
| F-page-7 | 0.51.0 | Given Settings → *wisp blocks* off, when an agent answers, then it's plain markdown | built | Settings → General → wisp blocks (`OnOffRow`, `runtime.blocks`); off runs the harness with `--plain` (plain markdown); test `shell-settings/ui/test/source.test.ts` `…_v1_blocks_switch` (round 39) |
| F-page-8 | 0.49.0 | Given a quick question, when the agent answers, then it's plain text, not a report | built | runtime prompt (`plugins/runtime/core`), Markdown block |
| F-page-9 | 0.2.0 | Given a malformed `wisp` fence, when the turn ends, then the blocks are salvaged and raw text kept | built | fence parser in `plugins/runtime/core` |
| F-page-10 | 0.47.0 | Given an answer, when I select words or hover a block and click Comment, then the comment goes with my next follow-up | missing | no comment store or bubble |
| F-page-11 | Unrel. | Given unsent comments, when I open Ship it or Merge, then it says *2 comments not sent yet* | built | Ship's dialog and Merge's confirm say *You have 2 review comments in Changes you haven’t sent*: shell-task's comments source answers `PromptSourceDef.waiting` (additive), Ship asks every source with its own client (`plugins/ship/ui/src/unsent.ts`), never reading shell-task's store; test `unsent.test.ts`; round 35 |
| F-page-12 | 0.57.0 | Given a finished turn, when I read its trail, then a receipt says *38k tokens · 71% cache · 3% of weekly* | built | `plugins/shell-task/ui/src/cards/model.ts` `receiptOf` (v1 receipt.js: cache share, longest window, Past your plan) under each turn via `shell.turn:foot`; test `each_card_says_why_a_turn_stopped_was_held_what_changed_and_what_it_cost`; round 12 (2026-11-11) |
| F-page-13 | 0.57.0 | Given Claude ran subagents, when I read the trail, then it says which and where the tokens went by model | partial | claude core parses `modelUsage`; no GUI |
| F-page-14 | Unrel. | Given a Claude task ≥100k tokens idle past its cache, when I reply, then a line warns the cache went cold | partial | `frame/cold.ts` over `runtime.cold`, the kit `ReplyBox.hint` (long and short forms, `bp-bar-cold`); test `a_large_idle_tasks_cold_cache_and_compact_now_say_what_v1_said_and_when`; not seen on a real cold task (needs a ≥100k-token idle Claude task); round 14 (2026-11-11) |
| F-page-15 | Unrel. | Given a Claude task ≥200k tokens, when I pick *Compact now*, then the context shrinks | partial | Compact now in the task's ⋯ menu with v1's note while the cache is warm (`runtime.compact`, optimistic running); same test; not seen on a real large task; round 14 (2026-11-11) |
| F-page-16 | Unrel. | Given a task, when the CLI changed between turns, then *What changed* says version, tools, Codex models | built | runtime keeps `ext["wisp.runtime"].cli` per turn (`finish.rs`, test `a_turn_keeps_what_the_cli_was`); `WhatChanged.tsx` + `whatChanged` (version, model catalogue); round 12 (2026-11-11) |
| F-page-17 | 0.56.0 | Given Claude refuses (usage policy), when the refusal card shows, then *Hand to …* moves the task to another harness | built | `HaltCard.tsx` reads `turn.refusal` {agent, model, vendor} (`cards/model.ts` haltOf): Hand to … the harnesses on another vendor's model, every other harness when the vendor is unknown (tests `cards.test.ts`, `vendors.test.ts`); round 14 (2026-11-11) |
| F-page-18 | Unrel. | Given a Claude task, when I click *Run subagents on Haiku*, then built-in subagents use Haiku | built | Settings → Usage → Subagents run on (`plugins/budget/ui/src/panes/Usage.tsx`, setting `runtime.subagentModel` → claude's CLAUDE_CODE_SUBAGENT_MODEL); round 13 (2026-11-11) |
| F-page-19 | 0.46.0 | Given a task, when I press ] or the panel button, then a side panel opens with Changes, PR and Shell | built | `SidePanel.tsx`: Changes, PR (`PrPane.tsx`) and Shell (`ShellPane.tsx`); PNGs r12-pr-*, r12-shell-*; round 12 (2026-11-11) |
| F-page-20 | 0.51.0 | Given Changes, when I open it, then every file changed since the base shows with a diff (first one open) | built | `git.changes`, `SidePanel.tsx` `Diff` |
| F-page-21 | 0.51.0 | Given Changes in a worktree, when I tick Stage and commit, then it commits | built | `ChangesPane` (plugins/shell-task/ui): Stage per file and per hunk, the commit row (Enter, the task title as placeholder); optimistic, rolled back with a toast; packages/ui/test/changes.test.tsx |
| F-page-22 | 0.51.0 | Given a hunk, when I click Revert (or tick Viewed), then that hunk or file goes back | built | Revert per hunk (hidden at once) and Revert file in ⋯, Viewed per file; packages/ui/test/changes.test.tsx |
| F-page-23 | 0.51.0 | Given a diff line, when I comment on it, then the comment goes with the next follow-up | built | Changes' line comments (`ChangesPane.tsx`, `comments.ts`): numbered over the reply box (`CommentTray.tsx`), sent at the top of the next follow-up in v1's words (`withComments`); tests `comments.test.ts`; the row was stale |
| F-page-24 | 0.51.0 | Given a changed file, when I click Edit, then it opens in wisp's editor and saves | built | the file view in the Changes pane (kit `FileView`, shell-task `FilePane.tsx`, `?side=changes:<task>&file=`): ✎ on a changed file, edit, Save / ⌘S (`worktrees.save`: refused while the agent works, or if the file changed), Back to Changes; the why-gutter (`history.blame byLine`) opens a line's task; tests `the_file_view_reads_only_inside_the_tasks_folder_and_only_text`, `the_why_gutter_marks_where_each_task_starts_…`, `a_file_in_the_changes_side_round_trips_through_the_url_…`; seen in Chrome 1440 light, 390 dark; round 17 (v1's ✦ ask about a selection: not ported) |
| F-page-25 | 0.51.0 | Given the editor, when I hover or go to definition, then a language server answers (TS, Python, Go, Rust) | partial | Go to definition: ⌘-click or F12 on a name (kit `FileView.onDefinition`) → `worktrees.grep {def}` (v1's `?def=`, git grep for where it's declared) opens that file at its line (`file=path#L12`, its number marked); tests `go_to_definition_finds_where_a_name_is_declared`, `go_to_definitions_place_opens_at_its_line_…`; seen in Chrome; round 18. Hover answers from a language server: not yet |
| F-page-26 | 0.51.0 | Given Changes, when I click *Open file*, then any file of the task opens (search too) | missing | no file browser |
| F-page-27 | 0.46.0 | Given the side panel's Shell, when I type, then a login shell runs in the task's worktree (End shell keeps it ended) | built | `ShellPane.tsx`: kit `<Terminal>` over `terminal.shell.start`/`input`/`close` and `client.http(peer).events` (`/sessions/:id/shell`); seen in Chrome typing `echo hi-from-wisp` in the task folder; End shell / Start again; round 12 (2026-11-11) |
| F-page-28 | 0.46.0 | Given a task's PR, when I open PR in the panel, then checks, reviews and merge state show without noise | built | `PrPane.tsx` over `ship.details`: verdict + Merge / Fix conflicts, checks (passed folded), reviews, conversation (bots/outdated folded), files, Check now; tests `the_pr_pane_says_where_the_pr_stands…`, `the_pr_pane_shows_the_verdict_failing_checks_first…`; round 12 (2026-11-11) |
| F-page-29 | 0.51.0 | Given the side panel *Run*, when I click Run, then the task's app runs and its page shows beside the task (Logs, Restart) | built | Preview (`PreviewPane.tsx`, wisp.terminal's `run` kind): Run starts the app from the worktree with PORT, its page beside the task, Logs, Restart, Stop; a task's menu says Run app / Stop app (round 31: the row's `ext["wisp.terminal"].run` mark, set on start, cleared on stop or exit; `serve_terminal.rs` a_tasks_running_app…) and Run app starts it with its command (v1 runApp) |
| F-page-30 | Unrel. | Given the preview, when I pick an element, then its HTML and styles go in the reply box | built | Preview's Pick (round 28, ADR-0049): the run's page goes through wisp's own proxy (`plugins/terminal/host/src/proxy.rs`: frame headers stripped, v1's pick script injected at `/__wisp/pick.js`, loopback Host only); a click puts v1's text (selector, HTML, styles) in the reply box (`plugins/shell-task/ui/src/side/pick.ts`, `pick.test.ts`, proxy end-to-end test) |
| F-page-31 | 0.35.0 | Given a `preview` block, when it shows, then the live page is in the answer (cloud: the cloud's page) | partial | `packages/ui/src/blocks/Preview.tsx` shows the live page (device frames, scale to fit, sandboxed; a loopback URL says it may not load); left: the cloud half, mapping a box localhost to its grid preview through `BlockContext.previewUrl` (the frame passes none yet); test `map_doc_preview_graph_and_app_blocks_render_and_act_as_v1s_did`; gallery PNGs r13-{map,preview,graph,app}-*; round 13 (2026-11-11) |
| F-page-32 | 0.50.0 | Given a long job, when the agent calls `wisp_watch`, then a live page shows beside the task | built | `wisp_watch` is owned by wisp.runtime (`runtime.agent.watch`; the MCP owner moved from the unbuilt `watch.agent.apply`): open (html, path or url), state (merge), caption, navigate, reload, close, as v1 (`plugins/runtime/core/src/watch.rs`); the watch and its page in their own rows (`watch`, `watch_page`, migration 4) on the task's topic, the row's `watch` marker in the same transaction. The Watch tab beside the task (`WatchPane.tsx`): caption with the live Orb, the page sealed (`watch-doc.ts`: CSP first, the `wisp` bridge; a new state is posted, only a new page reloads), a url watch in its sandbox, Run it yourself with copy; Watch in the row menu and More. Tests: core 3, host `tests/watch.rs`, `watch-doc.test.ts` 2; seen in Chrome light, dark, 390. Left: the 'Opened Watch' activity line, the tab opening by itself on open; round 33; round 34: the Watch tab opens by itself when the agent opens a watch while you look at its task (not on a phone, not over Changes or Shell): `watch.opened`, `opensWatch`, `WatchOpen.tsx`; test `watch-open.test.ts` |
| F-page-33 | 0.29.0 | Given a task, when I press T (Take over), then the agent's session opens in a terminal inside wisp (or a terminal app/cmux) | built | T and *Open in <harness>* open the Terminal tab: `runtime.terminal` resumes the task's conversation in its harness's own CLI (`--resume`, its model and effort, v1's take-over note), a task without a folder from home, one with no conversation refused; test `take_over_resumes_a_tasks_conversation_in_its_own_cli_inside_wisp`; seen in Chrome 1440 dark / 390 light; round 19 (2026-11-12). Terminal apps/cmux: `terminal.app.open` (round 16) |
| F-page-34 | 0.51.0 | Given *Babysitting mode*, when I send a task, then it opens straight in the agent's own terminal | built | `runtime/host/src/term.rs` (`terminal.terminalSessions`, `/terminal …`, `runtime.terminal`, follow-ups typed in, turns read back when it ends), Claude's `resume_command`, `terminal.changed` emitted, shell-task's Terminal pane; tests `a_terminal_task_runs_in_the_harnesss_own_cli_…` (e2e), `a_terminal_task_opens_on_its_prompt_named_by_wisp_…`, `a_terminal_task_opens_its_cli_in_the_terminal_pane_beside_it`; seen in Chrome 1440/390 light and dark, a follow-up typed into the CLI; round 18 (2026-11-11) |
| F-page-35 | 0.51.0 | Given `/terminal …`, when I send it, then the task runs in a terminal in wisp | built | `/terminal …` starts that task in its terminal (`plugins/runtime/host/src/term.rs` `slash`, test in its module); the Terminal pane opens with it (`TermOpen.tsx`); the row was stale |
| F-page-36 | 0.51.0 | Given `/sandbox`, when I send it, then the task runs in a fresh cloud box | built | `/sandbox` in New task (sandbox-ui's prompt source, the launching view with the Sandbox pill from the first frame) → `sandbox.launch` (ADR-0047): the grid makes it, the project goes in (bundle + uncommitted changes, `.wisp/sandbox.sh` once), the task runs there and opens through this wisp (`/api/peer/<machine>`); refused up front until Claude is signed in for sandboxes; tests `a_sandbox_task_runs_in_a_box_of_its_own_with_the_project_and_goes_with_the_task` (serve_sandbox, a real `wisp-grid dev`), core and seed tests; seen in Chrome (launch, the task, its Sandbox row, phone dark); round 18 (2026-11-11). Not here: the Browser tab |
| F-page-37 | 0.34.0 | Given a picture or video in an answer, when I click it, then it opens full screen and arrows go through them | built | A picture opens wisp's viewer (`packages/ui/src/blocks/Viewer.tsx`) with the answer's other pictures and videos in order: ← / → and the arrows, the count, Escape/×/a click beside closes, a click zooms in where clicked; a video's Full screen (and the player's own) hands over to it. The pictures now load at all: `GET /api/sessions/:id/file?path=` (runtime `media.rs`, the core's `media_file`: inside the folder or the exact path a block named, a picture's or video's extension, Range for video, a CSP that runs nothing), `ctx.media` → this wisp or `/api/peer/<machine>`; tests `blocks-media.test.tsx` `…_v1_media_viewer`, core `…_v1_media_file`, host `media.rs` `…_v1_media_host`, `answer-media.test.ts` `…_v1_media_url`; seen in Chrome 1440 light / 390 dark (round 39) |
| F-page-38 | 0.32.0 | Given a picture in an answer, when I hover → Copy, then it pastes elsewhere | built | On hover a picture's bar has Copy image (PNG on the clipboard, drawn on a canvas when it isn't one; a link copied for another site's picture), Download, Show in folder; ⌘C in the viewer copies too; the button says Copied (`media-copy.ts`); test `blocks-media.test.tsx` `…_v1_copy_image` (round 39) |
| F-page-39 | 0.34.0 | Given a picture, when I click *Show in folder*, then Finder/Explorer opens with it selected | built | Show in folder on a picture's or video's bar (not for a link, not on the phone app): `runtime.reveal` opens Finder/Explorer on the task's computer (where the agent saved it, else wisp's copy; a `doc` block's file too), a toast with the path when it can't; tests host `media.rs` (reveal), `…_v1_media_viewer` (the button, `source` first) (round 39) |
| F-page-40 | 0.3.0 | Given an image an agent saved in `/tmp`, when I reboot, then it still shows (copied to `~/.wisp/shots`) | built | Each local picture or video a turn shows is copied into `~/.wisp/shots/<task>/<turn>-<i>.<ext>` when the turn ends (25 MB / 200 MB caps, v1 keepImages); the block names the copy, `source` keeps the original, and the page asking for the original gets the copy; the folder goes with the task; tests core `…_v1_keep_images`, host `media.rs` `a_screenshot_in_tmp_is_copied_into_shots_and_still_shows_once_its_gone_v1_keep_images` (round 39) |
| F-page-41 | 0.55.0 | Given a `.env` in a diff or activity, when it shows, then values are hidden | built | Same rules as v1 `server/env-mask.js` (`.env`/`.env.*`, not `.example`/`.sample`; `KEY=••••`, keys, comments and empty values kept; a changed value reads `(changed)`). Changes: git masks a `.env` file (`git.changes` `mask`, setting `git.maskEnvFiles`), and the edits wisp saw (no git) mask in the pane (`filesOf` `mask`, `seenMasked`). Transcript: a step whose command or file names a `.env` file (`cat .env`, `head apps/.env.local`) shows its output masked; an answer's `code` or `diff` block about one (snippet or unified diff) too. Each has v1's line ("…’s values are hidden", Reveal ⇄ Hide in place, fixed size; kit `EnvMask`, parts `changes.envMask`/`changes.envReveal`, `turn.transcript.envMask`, `block.code.envMask`, `block.diff.envMask` + `.reveal`), revealed per task for the tab's life (shell `env-reveal.ts`, `BlockContext.env`); pure mask in `@wisp/ui` `content/env-mask.ts`. Tests: kit `env-mask.test.tsx` `F-page-41: isEnvFile…`, `…maskText…`, `…maskEdit…`, `…namesEnvFile…`, `…maskBlock…` (v1's cases), `…a code block about a .env file…`, `…a diff block…`, `…without a host…`; `changes.test.tsx` `F-page-41: a .env file has v1 env-mask's line…`; shell `env-reveal.test.tsx` `F-page-41: a step that read a .env file…`, `…revealed .env views stay shown per task…`, `…the transcript step’s output has v1’s line…`; shell-task `changes.test.ts` `…once revealed it stays shown…`, `…the edits wisp saw to a .env file…`; apps/web `mock-git.test.ts`. Seen in Chrome 1440 light / 390 dark (round 41: transcript step, code and diff blocks, Reveal ⇄ Hide, still shown after leaving the task and coming back) |
| F-page-42 | 0.13.0 | Given a finished turn, when I click 👍/👎, then feedback goes to the wisp team | built | 👍 / 👎 at the end of each finished turn's trail (`RateButtons`, faint until hovered or rated; the one that's on takes it back; 👍 pops); after 👎 one optional line (`WhyForm`: Enter sends, Skip thanks, Escape closes). `telemetry.feedback` (new, uiOnly) keeps the rating on the turn (`ext["wisp.telemetry"].feedback`), tells Auto (`router.signal`), sends `turn_rated` / `feedback` with the run's setup (never the prompt) and keeps what no sink took in the outbox; tests telemetry host `feedback.rs` `…_v1_feedback`, `rate.test.ts` `…_v1_rate_turn`, kit `rate.test.tsx` `…_v1_rate_buttons`; seen in Chrome 1440 light / 390 dark (round 39) |
| F-page-43 | 0.45.0 | Given Home or `/bug`, when I click *Tell us*, then a feedback dialog sends a report | built | Send feedback (`shell.feedback` dialog: Idea or thought / Something broke, a thumb about wisp (not for a bug), the words, Send or ⌘↵; thanks at once, a refusal opens it again with the words) from Home's foot line (Tell us), ⌘K Send feedback…, and `/feedback …` / `/bug …` in New task or a reply box (sent at once; no words opens the dialog); test `feedback.test.ts` `…_v1_feedback_command`; seen in Chrome (round 39) |
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
| F-goal-8 | v2 | Given a goal, when it asks for judges in a sandbox (or the task runs in one), then its judges run in that sandbox | built | `goal: {…, sandbox: true}` → `sandbox.place {judges}` (one, reused every round) and `runtime.quick` there; a sandboxed task's own goal plugin judges inside it; test `a_goal_may_ask_for_its_judges_in_a_sandbox`; round 18 (2026-11-11). Not seen in Chrome (no UI to ask for it yet: the goal's own setting) |

## 5. Crew (`CREW`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-crew-1 | 0.40.0 | Given Crew → Add, when I give a name, role, brief and schedule, then a member exists and checks in on its clock | built | the `crew.editor` dialog (`plugins/crew/ui/src/CrewEditor.tsx`, `editor.ts`): name, role, brief, checks in, jobs at once, harness, mode, folder, Wakes (ADR-0043); + on the rail, Edit… on the page; tests `the_crew_editor_saves_only_what_changed_…`, `a_crew_member_row_reads_its_fields_from_its_body_…`; seen in Chrome (role and a hand-off wake kept across a reload); round 16 (2026-11-11) |
| F-crew-2 | 0.40.0 | Given a member, when I build their spirit (body, glow, eyes, mouth, extra), then the face shows everywhere | partial | spirit in `crew/api`, kit `packages/ui/src/crew`; no builder mounted |
| F-crew-3 | 0.40.0 | Given a member, when I click them, then their thread fills the main pane with every job as a conversation | built | `plugins/crew/ui/src/CrewPage.tsx` on `shell.screen:crew` (kit `CrewView`, v1 crew.css .crew-view): head with Pause/Resume, ⋯ (Check in now, Remove), the thread oldest first with quiet check-ins folded (`page.ts`, `jobs.ts` reads `body.ext["wisp.crew"]`), the side (facts, Check in now, Notebook and Brief edited in place, Skills), the job box (`crew.assign`); test `a_members_page_reads_its_jobs_from_the_peers_task_rows_and_says_how_it_works`; seen in Chrome at 1440 light, 1024 dark, 390 dark, a job given from the box ran and showed in the thread; round 15 (2026-11-11) |
| F-crew-4 | Unrel. | Given a wide window, when I look at the sidebar, then a rail shows each member's face; clicking filters the list to their jobs | built | the rail's pick filters shell-list to the member's jobs (`state.ts` `setCrew`, `wire.ts` lifts `ext["wisp.crew"]` to `crew`), "No tasks for X yet" when none, and the tint (#768); the rail read `crew.member` rows while the host writes `crew_member` (fixed); tests `a_picked_crew_members_list_holds_only_their_jobs_read_from_the_rows_crew_note`, `a_picked_crew_members_list_holds_only_the_tasks_that_are_their_jobs`; seen in Chrome; round 15 (2026-11-11) |
| F-crew-5 | Unrel. | Given the rail, when I hover a face, then a card shows name, role, status and tasks | built | the face's card beside the rail (round 28): kit `app/RailCard.tsx` (v1 timings 160/180/90 ms, the crossing rule, ←→↑↓ Home End Esc), crew's `RailCard.tsx` on `shell.rail:card` (status line, jobs most urgent first, 6 at most, rows held while up); `rail-card.test.tsx`; a delegated job leaves the desktop list |
| F-crew-6 | 0.40.0 | Given members, when they work, then a notebook keeps facts between jobs without filling context | built | crew core notebook; agents update via `wisp_crew_edit` |
| F-crew-7 | 0.40.0 | Given a member, when I open *Also starts when*, then it starts on events (PR opened, CI failed…) | built | `crew.wake` + triggers (ADR-0043) |
| F-crew-8 | 0.40.0 | Given any task, when I ask *add a crew member who reviews PRs hourly*, then it's added | built | `wisp_crew_add/edit/remove` tools (from members and subagents too, v1 0.55) |
| F-crew-9 | 0.40.0 | Given a member on another machine, when they get a job, then it runs there | partial | `crew.assign`, machines route; not verified end to end |
| F-crew-10 | 0.40.0 | Given a member, when I edit *Skills and instructions*, then their own skills and AGENTS.md go with each job | partial | `crew.kit`; `KitSection.tsx`, `KitEditor.tsx` exist but aren't mounted |
| F-crew-11 | 0.43.0 | Given a delegated crew job, when I click its row in the lead's team panel, then the job opens | partial | delegations recorded; team panel not mounted |
| F-crew-12 | 0.41.0 | Given a member or the whole crew, when I click Share, then a `.crew.json` or link is made; dropping one imports it | partial | `crew.export`, `crew.import`; GUI not mounted; Import… built (round 22: `ImportCrew.tsx` over `crew.import`, dry run then who joins; the editor's Import… opens it) |
| F-crew-13 | 0.43.0 | Given a member, when I pick *See what X used*, then their usage and what ate my limits show | partial | `crew.stats`; no GUI |
| F-crew-14 | 0.49.0 | Given the Org page, when I drag cards, then the chart keeps my layout | built | The Org page (round 22) and, round 26, v1's free layout: drag a card to move it (saved through `crew.set_layout`, shown at once), drag from its handle onto another to link, Reset layout with Undo; kit `OrgView` `layout`/`onMove`/`onLink`, `placeFree` tested |
| F-crew-15 | Unrel. | Given a member's job that asks me something, when I look at the list, then it's in Needs you with their face | partial | list includes crew jobs; face on row not verified |
| F-crew-16 | 0.42.0 | Given the Crew section, when nobody is busy, then two members stay and the rest fold (busy first) | partial | rail only; no compact Crew section |
| F-crew-17 | 0.40.0 | Given a member's check-in, when it schedules a follow-up and finds nothing, then the follow-up still comes | built | `later.agent.schedule` (resume_later) |
| F-crew-18 | 0.40.0 | Given the API, when I `POST` a job or check-in, then the member runs it | built | `crew.assign`, `crew.checkin`; CLI `wisp crew …` |
| F-crew-19 | 0.40.0 | Given a member's kit, when it builds its own, then the kit is saved | partial | `crew.kit`; UI sends `crew.localKit` (no manifest) |
| F-crew-20 | Unrel. | Given a member's finished job, when its toast or notification is clicked, then that job opens | partial | notifications not mounted |

## 6. Automations, triggers, schedules (`AUTO`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-auto-1 | 0.8.0 | Given Automations → Triggers, when I add a cron schedule, then a task starts on time | partial | Automations → Triggers → New trigger (`TriggerEditor.tsx`): the When picker over `automations.sources` grouped by plugin (kit `SelectOption.group`), the source's fields from its schema, the prompt, saved with `resources.apply`; Test on the last 5 events (`automations.trigger.test`); test `the_when_picker_groups_sources_by_owner_reads_their_fields_and_writes_the_trigger_spec`; seen in Chrome. Left: automations' own sources (schedule, once) declare no field schema, so no cron field shows; round 15 (2026-11-11); round 32: ⌘K Recipes / Triggers open Automations on that tab (Settings' `filter`), as v1's ⌘K did; the form isn't v1's yet (kind tiles, Send to, Project, Run); round 33: v1's trigger form in v1's Automations dialog (`automations.page`, kit `AutomationsBody`/`TriggerKinds`/`AutoRow`/`AutoPresets`): the 10 kind tiles, Name, Send to, Project, When with its presets and read-back, Branch, Label, the hook fields, Check every, Run (prompt or recipe), Mode, Harness, the warning; saved as a `trigger` resource (`trigger-form.ts`, test 2); parity 0/177 parts off at 1440 and 900. Left: Harness is a select, not v1's runner picker; Task marked done and Linear issue have no v2 source and say so; round 34: Harness is v1's runner button (`AutoRunner`) opening New task's harness · model picker (`RunnerPicker`, now exported from `@wisp/shell`), with Use launcher default; saves `agent` and `model`; parity metrics pass at 1440, 900 and 390 |
| F-auto-2 | 0.8.0 | Given a *CI failed* trigger, when a GitHub Actions run fails, then a task starts (or follows up the branch's task) | built | `github` trigger sources; follow-up on the same branch in automations host |
| F-auto-3 | 0.51.0 | Given Slack, Linear, Sentry, PagerDuty or a webhook trigger, when it fires, then a task starts | partial | `automations.trigger.push`, webhook source; Sentry/PagerDuty/Linear kinds not verified |
| F-auto-4 | Unrel. | Given a Slack trigger with `users`, when someone not listed posts, then nothing starts | partial | not verified |
| F-auto-5 | 0.42.0 | Given a task, when I type *in 10 min check again* in the reply box, then the follow-up goes then | built | wisp.later's `later.reply` prompt source (`reply.ts` `replyPlan`: a time at the start or "remind me … in 1 h", v1's exceptions: Read times off, the wisp agent, a reminder, a subtask, an open question, /btw, @member) → `later.add`; the row over the box (`wisp.later.foot`: At 14:45 · set by you, Send now, Cancel) shows at once, a refusal puts the text back (`send` ctx `restore`, additive); tests `reply.test.ts` (2); seen in Chrome 1440/390 light/dark (round 40). Left: v1's chip that shows the time read before Enter, and its × Not a time |
| F-auto-6 | 0.42.0 | Given scheduled items, when I look at the list, then a Scheduled section holds tasks, reminders and check-ins | built | shell-list now watches `plugin:wisp.later:later` and reads `later_plan` (`model/wire.ts listPlan`): Scheduled shows tasks and reminders; opening one shows `later.plan` (`plugins/later/ui/src/ui/PlanPage.tsx`, test `the_plan_page_says_when_it_starts…`); PNGs r12-plan-*; round 12 (2026-11-11) |
| F-auto-7 | 0.49.0 | Given a waiting item, when I click Edit, then I change its text or time before it goes | partial | `later.edit`; GUI not mounted |
| F-auto-8 | 0.56.0 | Given an agent scheduled a check-in, when its task finishes, then it moves from Needs you to Scheduled | partial | `later.agent.schedule`; list placement not verified |
| F-auto-9 | 0.42.0 | Given a plan near the limit, when work would pass it, then it waits for the reset and goes after | built | `budget.hold`, `later.waitAtLimit` |
| F-auto-10 | 0.51.0 | Given *Automations stop at* per harness, when usage passes it, then automations wait | built | Settings → Usage: Automations stop at, and each harness's own line (`budget.setStop`), parity shot r13 usage 1440/390; round 13 (2026-11-11) |
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
| F-stuff-2 | 0.49.0 | Given an agent saves with `wisp_save`, when it does, then a `stuff` card shows in the answer | built | `packages/ui/src/blocks/Stuff.tsx` (kind, title, Launch/Open via BlockContext.openStuff), `wisp_save`; round 12 (2026-11-11); until then the renderer was a stub drawing "Unknown block" |
| F-stuff-3 | 0.49.0 | Given a kept item, when an agent saves with its id, then a v2 appears in place | built | `stuff.update`, `stuff.restore` |
| F-stuff-4 | 0.49.0 | Given an app folder, when it's saved, then Launch opens it in wisp | built | My Stuff's Open on an app launches it (`stuff.launch`) and opens its address; Stop (`stuff.stop`); a pinned app launches in its pane (Home, beside tasks) |
| F-stuff-5 | 0.50.0 | Given `"db": true`, when the app runs, then it keeps data (seed.sql once, no 5 s cut on a slow disk) | built | per-app SQLite (ADR-0020), `stuff.resetData` |
| F-stuff-6 | 0.50.0 | Given an app, when I click Publish, then it's at a grid link; secrets and source maps stay off | partial | My Stuff's menu: Publish to <grid> (`stuff.targets`), Copy / Open public link, Update the public link, Unpublish, v1's toasts (`StuffPage.tsx`); not seen against a grid; round 14 (2026-11-11) |
| F-stuff-7 | Unrel. | Given *make me a pane that…*, when I send it, then an agent builds a pane and it pins beside tasks or on Home | built | Make a pane (`MakePane.tsx`); a pinned app shows on Home (round 26: `plugins/stuff/ui/src/HomePanes.tsx` on `shell.home:cards`: tiles side by side, a row that opens it as a page stacked; its frame behind the CSP wrapper, its calls through `panes/host.ts` with the Allow card and a card per write). Beside tasks (round 28): Pin beside tasks in My Stuff; each app pinned `@task` is a tab in the panel beside the open task (`SideTabDef` on the plugin UI contract, `plugins/stuff/ui/src/TaskPane.tsx`), hearing the task as `wisp.context`; `pins.test.ts`, `term.test.ts` |
| F-stuff-8 | Unrel. | Given a pane, when it asks for `tasks:write`, then it can only propose a prompt, loses access when code changes, and can't grow during Full auto | partial | `stuff.grant`, `stuff.allow`; enforcement not verified |
| F-stuff-9 | Unrel. | Given Agent board and Allowance board starters, when I add one, then it shows tasks and periods | built | Make a pane's starters: Add keeps it and pins it on Home (the Allow card first), Pin again after a No (round 26) |
| F-stuff-10 | 0.50.0 | Given the phone app via wisp Cloud, when I open My Stuff, then I can launch apps | missing | no phone frontend |

## 10. Sharing (`SHARE`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-share-1 | 0.51.0 | Given a task, when I pick Share…, then it's on my wisp Grid at a link anyone can open | built | Share… in a task's row menu opens `ShareDialog.tsx` (mounted round 30 as `stuff.share`, v1's words); `share.create`/`share.preview` (ADR-0032, 0038); `share-params.test.ts` |
| F-share-2 | 0.51.0 | Given a share link, when I import it, then the task is in my list | built | `share.import`, `runtime.import`, CLI `wisp share` |
| F-share-3 | 0.51.0 | Given a share, when I stop it, then the link stops working | partial | My shares under Settings → Cloud (`grid-client/ui/src/panes/MyShares.tsx` over `grid-client.shares`/`revoke`: kind, access, views, imports, version, Copy link, Open, Stop sharing), test `my_shares_lists_what_i_shared_with_its_access_counts_and_version_live_ones_first`; not seen in Chrome (needs a grid sign-in); round 15 (2026-11-11) |
| F-share-4 | Unrel. | Given a phone share sheet (Android), when I share a link or PDF to wisp, then New task opens with it attached | missing | no Android frontend |

## 11. Machines, cloud and the grid (`MACH`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-mach-1 | 0.9.0 | Given another computer over SSH, when I add it in Machines, then agents run there | partial | `machines.add`, `connect`, ADR-0010; Machines UI not mounted |
| F-mach-2 | 0.10.0 | Given `~/.ssh/config` and Tailscale, when I open Machines, then found hosts are listed | partial | `machines.discover`, `machines.hosts`; no GUI |
| F-mach-3 | 0.27.0 | Given a machine that doesn't know my key, when I click *Let me in*, then my password once installs it | partial | `machines.letIn`; no GUI |
| F-mach-4 | 0.27.0 | Given a machine with only SSH, when I add it, then wisp installs Node and itself there | partial | v2 ships a binary; install over SSH not verified |
| F-mach-5 | 0.11.0 | Given a machine on an older wisp, when I click *Update to X*, then it restarts on this version | missing | no remote update command |
| F-mach-6 | 0.22.0 | Given any project, when I pick a machine, then it runs there; a follow-up can move the task to another computer | partial | `machines.route`; GUI run-on not mounted; round 18: every machine this wisp keeps is a peer of the app through `/api/peer/<machine>` (machines' proxy over its link), so its tasks show and open in the list (a sandbox's seen in Chrome); Run on in the GUI still to do |
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
| F-mach-17 | 0.51.0 | Given `/sandbox`, when I run it, then a fresh box runs the task and I can remove it | built | Settings → Computers → Sandboxes (sandbox-ui): the Claude sign-in for every sandbox (`claude setup-token` on a pty, token sealed on the grid), env vars (names only), each sandbox with its owner, Open its task, Sign in to Codex there (its device login), Delete; a sandbox goes with its owner (task, delegate, crew job or member, judges) and the sweep; tests `deleting_the_owner_drops_its_sandboxes_…`, `the_sweep_drops_failed_drops_…`, `claude_setup_token_shows_its_link_…`; seen in Chrome; round 18 |
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
| F-chan-6 | Unrel. | Given Discord, when I use `/wisp`, then a task starts and replies come back | built | `discord/core/src/interaction.rs`, `discord/host/src/slash.rs`: `/wisp` registered, deferred and edited, a thread on its reply, autocomplete (linked people only), signed buttons, a cloud wisp's held interactions checked with Ed25519; tests `tests/interactions.rs` (4), core 6; round 18 (2026-11-11). Not seen against real Discord |
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
| F-acct-9 | 0.8.0 | Given Settings → Usage, when I open it, then spend, turns, success by project and harness · model show | built | Settings → Usage shows spend, turns, worked and questions as v1's tiles (kit `Stats compact`, label over value); left: Charts and breakdowns (per day, project, harness · model) and Crew track record need a per-day usage command from the backend; round 13 (2026-11-11) Round 24: Open usage is a dialog (7/30/90 days, tiles, per day, by project, by harness · model) over `runtime.usage`'s breakdowns |
| F-acct-10 | 0.42.0 | Given Plan budget, when I open it, then each account's 5-hour and weekly windows show, with banked Codex resets | partial | `budget.view`, `accounts.limits`; no GUI |
| F-acct-11 | 0.43.0 | Given usage reports, when windows move, then wisp shares the change out among tasks (*Where your plan went*) | partial | budget core; no GUI |
| F-acct-12 | 0.51.0 | Given *Drain watch* on, when an account drains fast, then wisp warns | built | Settings → Usage: Drain watch switch (`budget.drainWatch`), the drain callout with Copy report and Dismiss (`budget.dismissDrain`), `budget/ui/src/drain.ts` test `drain_watch_and_window_changes_say_what_v1_said`; seen in Chrome; round 14 (2026-11-11) |
| F-acct-13 | 0.55.0 | Given a window changes length or reset, when wisp reads it, then it says so | built | Settings → Usage: each window change as a row with × (`budget.dismissNotice`), v1's words (`noticeWords`), same test; round 14 (2026-11-11) |
| F-acct-14 | 0.57.0 | Given two accounts, when I open Usage, then tokens per model per account show | partial | budget core; no GUI |
| F-acct-15 | 0.54.0 | Given Codex says 429 with room left, when it does, then wisp tells limits apart | built | codex host/budget |
| F-acct-16 | 0.57.0 | Given Codex *model at capacity* in Auto, when it happens, then Auto moves on | partial | router; not verified |
| F-acct-17 | 0.7.0 | Given finished tasks, when they go quiet, then a retro learns preferences and lessons, shown in Memory | built | Settings → Memory (`plugins/learn/ui/src/panes/Memory.tsx`, v1's pane: Learn from tasks on `learn.enabled`, Remembered with the last retro, Open memory → every project's and each project's preferences and lessons, remove and add through `learn.set`, the recent retros from `learn.view`); test `the_memory_pane_counts_what_is_remembered_lists_scopes_and_edits_one_list`; seen in Chrome at 1440 light/dark and 390, an added preference read back after a reload; round 14 (2026-11-11) |
| F-acct-18 | 0.14.0 | Given Settings → Auto, when I set goal, allowed harnesses and best-of-two, then Auto follows | built | `plugins/router/ui/src/AutoPane.tsx`, `router.set` |

## 15. Settings (`SET`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-set-1 | 0.8.0 | Given Settings, when I open it, then it's a sidebar of panes (General, Notifications, Agents, Auto, Usage, Memory, Automations, Phone, Machines, Cloud, Connectors, This Mac) with the X pinned | built | v1's sheet: 900 × 680 centred (`Dialog size="xl"`, tokens `size-dialog-xl[-h]`), flat nav in v1's order (`plugins/shell-settings/ui/src/frame.tsx` `V1_ORDER`, test `settings_nav_is_v1s_flat_list_in_v1s_order_with_v2s_own_panes_after`), 200 px nav, 58 px head; full screen on a phone, opening on the list; `qa/parity.mjs --views=settings.general`: every settings part (settings, settings.nav, settings.head, settings.review) matches v1 at 1440 light/dark; round 13 (2026-11-11) |
| F-set-2 | 0.31.0 | Given General → Theme, when I pick System, Light or Dark (or ⌘K), then the theme switches | built | `shell.theme` setting, `Appearance.tsx` |
| F-set-3 | 0.32.0 | Given General → Terminal, when I pick in-wisp, Auto-detect or an app, then Take over uses it | built | `General.tsx` Take over in: wisp.terminal's `terminal.apps` list (it was hidden: no `terminal.app` rows were ever published); round 13 (2026-11-11) |
| F-set-4 | 0.8.0 | Given General → Editor, when I pick one, then Open in editor uses it | built | `General.tsx` editor setting |
| F-set-5 | 0.8.0 | Given General → Worktree per task, when I turn it off, then tasks run in the repo | built | `General.tsx` Worktree per task switch (`KEYS.worktree`), seen in Settings → General; round 13 (2026-11-11) |
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
| F-key-5 | 0.3.0 | Given a focused task, when I press J/K, then focus moves down/up; O or Enter opens | built | `packages/shell/src/builtins.tsx` shortcuts, the open task's page through `frame/task-keys.ts` (a cancelable DOM event TaskView handles as its buttons do); test `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`; J/K walk the rows (with a task open it follows), O/Enter open (Enter only off a control); round 13 (2026-11-11) |
| F-key-6 | 0.3.0 | Given a focused task, when I press E, A, L, M, Delete, then done, archive, for later, rename, delete | built | `packages/shell/src/builtins.tsx` shortcuts, the open task's page through `frame/task-keys.ts` (a cancelable DOM event TaskView handles as its buttons do); test `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`; E, A, L, M, Delete/Backspace on the open task or the picked row; round 13 (2026-11-11) |
| F-key-7 | 0.8.0 | Given a focused task, when I press S, ⇧R, ⇧F, T, V, D, P, ], /, then ship, rerun, fork, take over, transcript, changes, PR, panel, reply | built | `packages/shell/src/builtins.tsx` shortcuts, the open task's page through `frame/task-keys.ts` (a cancelable DOM event TaskView handles as its buttons do); test `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`; S, ⇧R, ⇧F, T, V, D, P, ], / and 1–9 (an answer); seen in Chrome (D opens Changes, V the steps, the page keeps its state: the side panel no longer remounts it); round 13 (2026-11-11) |
| F-key-8 | 0.8.0 | Given a long feed, when I press U/Home or C, then back to top or collapse all | built | `packages/shell/src/builtins.tsx` shortcuts, the open task's page through `frame/task-keys.ts` (a cancelable DOM event TaskView handles as its buttons do); test `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`; U (back to top), C (collapse: folds the steps and older turns); round 13 (2026-11-11) |
| F-key-9 | Unrel. | Given the desktop app, when I press Ctrl+` , then the terminal toggles | built | `packages/shell/src/builtins.tsx` shortcuts, the open task's page through `frame/task-keys.ts` (a cancelable DOM event TaskView handles as its buttons do); test `v1s_keys_walk_the_list_act_on_the_picked_row_and_reach_the_open_tasks_page`; Ctrl+` opens the Shell side pane; round 13 (2026-11-11) |
| F-key-10 | Unrel. | Given ⌃Tab, when tapped or held, then the switcher | built | see F-task-23 |

## 17. CLI and integrations (`CLI`)

| ID | v1 | Scenario | v2 | Evidence or gap |
|---|---|---|---|---|
| F-cli-1 | 0.6.0 | Given a terminal, when I run `wisp "fix the test" --wait --json`, then the task runs and prints its result | built | `crates/wisp/src` launch options |
| F-cli-2 | 0.6.0 | Given tasks, when I run `wisp ls --state=review`, `show`, `wait`, `reply`, `stop`, then they work (a bad state errors) | built | `COMMANDS`, `LS_STATES` in `args.rs` |
| F-cli-3 | 0.8.0 | Given a task, when I run `wisp ship <id>` or `wisp merge`, then it ships or merges | built | `args.rs` |
| F-cli-4 | 0.8.0 | Given `--compare codex,opencode:model`, when I launch, then it runs on each | built | one task per harness, grouped (`groupId`): Compare runs shows them side by side (F-comp-30, round 33) |
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
| F-desk-1 | 0.2.0 | Given a Mac, Windows or Linux, when I open wisp.app, then wisp opens in its own window (Tauri, a third of Electron's size) | partial | the Tauri shell runs the v2 `wisp` binary (`wisp serve`, web/ beside it; `WISP_EXIT_WITH_STDIN` keeps it from outliving the app) and `desktop/scripts/package.mjs` stages it on every OS (round 29); the Windows build is checked by `tauri windows` CI, not run locally; qa/desktop-tauri-win.mjs still drives v1's entry.mjs |
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
