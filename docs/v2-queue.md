# v2 build queue (code first, verify later)

The coder takes the next unchecked item as soon as one ends, with no wait for review or CI. Rules are in
`docs/v2-team-brief.md`: stay compiling (`cargo check`), clippy on the touched crates, write the ADR's named tests,
no local full suites. The lead commits each item by concern and pushes; PR #756 CI runs the tests. CI failures
are fixed at the start of the next item.

**[x] Done 2026-11-10 (docs/v2-round-7.md, round 5).** **GUI naming (2026-11-10):** the task side menu still says "Take over". The decision is "Open in <harness>" (for example "Open
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
