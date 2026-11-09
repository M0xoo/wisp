# v2 build queue (code first, verify later)

The coder takes the next unchecked item as soon as one ends, with no wait for review or CI. Rules are in
`docs/v2-team-brief.md`: stay compiling (`cargo check`), clippy on the touched crates, write the ADR's named tests,
no local full suites. The lead commits each item by concern and pushes; PR #756 CI runs the tests. CI failures
are fixed at the start of the next item.

1. [x] **Events + triggers** (ADR-0044, then ADR-0043), plus the setup probe's "timed out" message (running).
2. [x] **Grid leftovers** (all but `wisp ssh`, see docs/v2-round-2.md) (ADR-0041 / v2-grid-round.md "Not built"):
   - GitHub and Google sign-in on the grid;
   - the boxd container driver;
   - sandboxes as peers;
   - `wisp ssh` through a grid ssh gateway;
   - teams in the CLI.
3. [ ] **Terminal context** (ADR-0023): `wisp.termctx` plus the `termctx.source@1` sources (tmux, WezTerm, kitty, iTerm2, scrollback), and the `terminal.failed` trigger source.
4. [ ] **Rest of the backend:**
   - the telegram, slack, discord, github and email transports, with the WebSocket client;
   - the computer pane (`wisp.machine`): sampling, guard, heavy-step lock;
   - the update host;
   - telemetry emitted from the owning plugins;
   - the 3 settings into the registry;
   - task and My Stuff mentions in prompts;
   - setup "changed since" and harness versions;
   - the uiOnly rule into tools/check;
   - the copilot session reader.
5. [ ] **GitHub Action and image, git hook** (ADR-0040).
6. [ ] **TUI** (ADR-0024): `wisp tui` mirrors the GUI with ratatui, from the Rust SyncClient; `tui.view`, `tui.input` and `term.block`; `--on <machine>`.
7. [ ] **GUI** (ADR-0016/0017/0012):
   - the 46 remaining views at v1 parity;
   - the new screens: Repo tab, blame gutter, import, Share setup, Setup section, My shares, Automations "When" picker and crew Wakes;
   - composer `@` and `/`.
   - Start by wiring the built screens to the real server: in the demo (`wisp serve` with the fake claude), `/task/<id>`
     mounts no task view (2026-11-09 check-in).
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
