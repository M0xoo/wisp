# v2 build queue (code first, verify later)

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
