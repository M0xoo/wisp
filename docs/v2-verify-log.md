# v2 verify log

The verifier's findings: one numbered list per round, newest first. Each item gives its severity
(**blocker** / **must-fix** / **nit**), where it is, what's wrong, and which rule or v1 behaviour it breaks.
Evidence (logs, shots, side-by-sides) is in `qa/out/verify/`.

## Round 1, 2026-11-08 (HEAD `445147ee` plus the coder's uncommitted work)

### Gates

| Gate | Result | Log |
|---|---|---|
| `npm run check` | ✅ 0 errors, 109 warnings (75 rust-sizes, 25 sizes, 8 i18n, 1 protocol) | `qa/out/verify/check.log` |
| `npm run typecheck` | ✅ exit 0 | `qa/out/verify/tsc.log` |
| `cargo clippy --workspace --all-targets -D warnings` | ❌ **does not compile**: 4 api crates (ts-rs), plus 4 lint errors | `qa/out/verify/clippy.log` |
| `cargo test --workspace` | ❌ **does not compile** (crew-api, grid, machines-core test). Without the 20 broken crates: 1,181 passed, **5 failed**, 13 ignored | `qa/out/verify/ctest4.log` |
| `cargo deny check` | ✅ advisories, bans, licences, sources ok; 11 duplicate-crate warnings | `qa/out/verify/deny.log` |
| `monoflow verify --all` | ❌ 117/149 packages pass; 32 fail | `qa/out/verify/monoflow.log` |
| `qa/parity.mjs --modes=desktop` | ❌ 48/96 shots (home 0/24, task 24/36, composer 24/36); the other 46 views have no desktop reference | `qa/out/verify/parity-desktop/` |
| `qa/parity.mjs --modes=browser` | ❌ 71/486 shots; **32 of 49 views not reachable** in v2 | `qa/out/verify/parity/` |
| `qa/layout.mjs` (kit gallery) | ❌ 4 problems (overflow-x at 390 and 320) | `qa/out/verify/layout-gallery.log` |
| `qa/layout.mjs --area=shell` | ❌ cannot run: its selectors are stale, so every page "never showed" | `qa/out/verify/layout-shell.log` |
| `qa/feedback.mjs` | ⬜ doesn't exist yet (design/feedback.md says a screen isn't done without it) | |

Per-crate test counts: wisp-store 78, wisp-kernel 64, wisp-sync 32, wisp-proc 30 (with g12), wisp-api 61: all pass.

### Findings

**Blockers: the workspace doesn't build at HEAD**

1. **blocker**: `plugins/connectors/api/src/rows.rs:39`, `plugins/router/api/src/types.rs:33,283,295`, and the other
   E0277 sites in `plugins/{automations,crew}/api` (16 in all). `#[ts(optional)]` is on non-`Option` fields (`bool`,
   `Vec<_>`), and ts-rs 12.0.1 (the version in Cargo.lock) refuses it. So `cargo build`, clippy and test fail for
   the whole workspace. Use `#[ts(optional)]` only on `Option<T>`. For a skipped `bool`/`Vec`, use
   `#[ts(as = "Option<bool>", optional)]` or drop the attribute. Rule: AGENTS.md *Commands* and §9.2 (clippy -D
   warnings from the first commit). The audit's claim that CI runs clippy and test (`docs/v2-quality-audit.md`)
   can't be true on this tree.
2. **blocker**: `plugins/crew/api/src/lib.rs:9-10` declares `pub mod commands; pub mod events;`, but neither file
   is committed (`git ls-files plugins/crew/api/src` lists only lib.rs and rows.rs). That's 34 errors, and wisp-crew
   and crew-core fail with it.
3. **blocker**: `apps/grid/src/pages.rs:11,13,14,20` declares modules `account`, `device`, `home` and `share`,
   whose files are missing. `apps/grid/src/pages/site.rs:48` puts an HTML literal in a normal string, so `report"`
   parses as a reserved prefix and needs a raw string. `apps/grid/src/pages/signin.rs:6` imports a `super::join`
   that doesn't exist. wisp-grid doesn't compile.
4. **blocker**: `plugins/machines/core/tests/resume_bench.rs:24`: `["claude","codex","opencode"][i % 3]` inside
   `json!` doesn't compile. Bind it to a local first.
5. **blocker**: `qa/out/verify/parity/task/1440-light-hover.v2.png` is an **empty white page**: v2 renders
   nothing for the task view in the 1440 light hover capture (29.8 % px differ). 1440 dark hover is fine, so it's
   either a race in first render or a crash. Check the console in that state.

**Must-fix: gates and tests**

6. **must-fix**: clippy lints that will show once item 1 compiles: `plugins/mcp/api/src/lib.rs:62`
   large_enum_variant (box `Plan`); `plugins/later/api/src/commands.rs:241` struct_excessive_bools;
   `plugins/later/api/src/model.rs:8` trivially_copy_pass_by_ref (`is_false(b: &bool)` is required by serde's
   `skip_serializing_if`, so add a local allow with a reason); `plugins/automations/api/src/words.rs:294`
   semicolon_if_nothing_returned.
7. **must-fix**: 5 Rust tests fail.
   - `plugins/channels/core/tests/policy.rs:137`: the sender name sanitiser strips the space, so it gives
     `"AdaLovelace"` where the test expects `"Ada Lovelace"`.
   - `plugins/telemetry/core/tests/common.rs:67`: 3 tests fail because their goldens
     (`plugins/telemetry/core/tests/goldens/*.json`) were never committed (AGENTS.md *Tests*: goldens are
     committed).
   - `plugins/telemetry/core/tests/telemetry.rs:105` expects `2026-11-07`, gets `2026-11-06`: the test depends on
     today's date or the time zone. Inject the clock (sans-IO core, AGENTS.md). As written it's a flaky test.
8. **must-fix**: `monoflow verify --all` gives 117/149. Besides the Rust crates above:
   - `packages/ui/test/css-rules.test.ts:35`: `app-frame.css` is no longer one `@layer` block (text follows the
     layer's close).
   - `packages/ui/test/css-rules.test.ts:62`: `app-task.css` has a raw `860px` outside `@media`/`@container`,
     where token px are required.
   - `apps/web/test/slots.test.tsx` (untracked, WIP): monoflow typechecks it without JSX, so every JSX line errors.
     `npm run typecheck` passes while monoflow fails: make the two configs agree (ADR-0001, monoflow is the gate).
9. **must-fix**: **the committed v1 reference is being rewritten** in the working tree (56 files under
   `design/v1-reference/{home,task,task.composer}`, plus 98 new `desktop-*` shots). The rewritten `metrics.json`
   keeps the **old `captured` stamp**, yet values changed. For example `card.title#0` went from fw 500 to 600, and
   `launcher.worktree` moved from x 1144.5 to 1136.5. foundation.md §1 says the reference "is committed and never
   edited by hand". Two captures of v1 disagreeing means the capture isn't deterministic (unread state,
   relative times, the clock). Fix the seed and clock in `qa/v1-reference.mjs`, recapture with a new
   `captured` stamp, and commit the reference on its own, with the reason. v2 currently fails because of it:
   `card.title#3: fw 600→500` on every home shot.
10. **must-fix**: `qa/layout-areas.mjs` can't find the app. It waits for `[data-kit="frame"]`, but the frame is now
    `[data-kit="stage"]` (`packages/ui/src/app/Stage.tsx:35`), and the paths (`/task/local%3As0000`) don't match the
    parity seed. So **the layout gate checks no app screen**, only the gallery. It also logged a real page error at
    home 320: `props.filter is not a function` (`packages/shell/src/frame/Sidebar.tsx:101/127`: something renders
    `Head`/`SidebarList` with a non-function `filter`).
11. **must-fix**: the kit gallery overflows horizontally at 390 and 320 px, because of `code` and `diff-body`
    (page 489 px wide at 390). A code or diff block has to scroll inside its own box (layout.md §6 overflow-x).
    Shots: `qa/out/verify/layout/`.
12. **must-fix**: `qa/parity.mjs` reports a view with no reference shots for the mode as `✔ 0/0` (46 views in
    desktop mode). It should say "no reference" and count as not covered. Desktop references exist only for home,
    task and task.composer, and the owner uses the desktop app.

**Must-fix: what the screens show** (side-by-sides, v1 left and v2 right, in `qa/out/verify/sbs/`)

13. **must-fix**: `sbs/home_desktop-900-light-rest.png`. The composer's second row (Recipes · prompt · New)
    **runs out of the card**: "+ New" sits on the card's right border and is clipped by the pane edge. The first
    row shows every icon, but v1 at 900 drops "in", turns *Other folder…* into an icon, ellipsizes the recipe text
    and shows *Issue* as an icon. Rules: nothing is clipped except by an ellipsis (foundation.md §4), and bars
    collapse (layout.md §2). 13/167 parts off, e.g. `launcher.issue` x 829→894.
14. **must-fix**: `sbs/home_desktop-320-light-rest.png`. The heading reads **"What should wis…"**: v2 truncates
    content text. v1 wraps it onto two lines, because a heading is content (layout.md §1). The location row clips the
    *Other folder* icon at the card edge, where v1 wraps that row. Under ADR-0012 it collapses into More and
    never clips. The Recipes block also differs: v1 shows "Prompts you send…" under Recipes, then New.
15. **must-fix**: `sbs/home_desktop-600-dark-rest.png`. The tip cards put **"Sign in →" / "Set up →" on their
    own line below the text** (card 108 px tall, v1's 80). v1 keeps the button on the right, centred on the row.
16. **must-fix**: `sbs/task_desktop-600-light-rest.png` and `task_desktop-320-light-hover.png`. A turn's
    footer is one line in v1: stats on the left, "1 file +1 −1" and the three action icons on the right. v2
    **breaks it into three lines** (stats / diff / icons), which moves `turn.fork` y from 352.5 to 399. A bar has
    wrapped (layout.md §2: one line, always).
17. **must-fix**: `sbs/task_desktop-320-light-hover.png`. The task head squeezes the branch onto the status row,
    so the project pill shows "wisp-r…" and the branch "wisp…-784f69". v1 gives the branch its own line and shows
    the pill in full (`target#0` y 117→97, h 57→52). Hover, focus and rest all fail at 320.
18. **must-fix**: `sbs/home_desktop-1440-light-focus.png`. In the focus state v1's launcher keeps its accent
    border, while v2's composer border is grey. A focus ring is lost (0.6 % px, over the 0.5 % budget). The
    top-right avatar (`me`) is also a differing region over 8×8 on every home shot
    (`parity-desktop/home/*-rest.diff.png`).
19. **must-fix**: `sbs/palette_1440-light-rest.png`. The palette is **a different design**:
    - a centred dialog titled "Command palette" with a close button, where v1 has an untitled search popover
      anchored near the top of the main pane;
    - a "Go to → What's using my computer" section v1 doesn't have;
    - every task subtitled "Review" instead of v1's `project · status · time` on the same line;
    - no Crew section and no Actions section (New task N, Start from an issue…), and its own `wisp` section of
      theme toggles;
    - the footer hint styled differently.

    77 % px differ.
20. **must-fix**: `sbs/stuff_1440-light-rest.png`. Clicking **My Stuff** in the sidebar **does nothing**: Home stays
    on screen. That breaks feedback.md (a click with no visible change) and leaves My Stuff unreachable.
21. **must-fix**: 32 of 49 reference views are **not reachable** in v2 (their opener's click times out):
    - every `settings.*` pane (13);
    - `crew`, `crew.add`, `crew.org`, `projects`, `automations.trigger-new`;
    - `home.issues`, `home.goal-judges`;
    - `task.changes`, `task.changes-diff`, `task.composer-goal`, `task.editor`, `task.goal-judges`,
      `task.goal-menu`, `task.more`, `task.preview`, `task.rerun`, `task.ship`, `task.transcript`;
    - `task.right-click` (a strict-mode violation: two `card.head` match the title).

    The reachable launcher variants (home.mode-menu, runner, team, goal-on, auto-preview, compare, where, later,
    worktree-off) all fail, usually because the menu or popover isn't drawn (`launcher.mode bg → -`,
    `x.button#37 missing`).

**Must-fix: architecture and rules**

22. **must-fix**: `packages/client/src/commands.ts:24`: `CommandDef` has **no `pending` field**, and
    `optimistic: 'none'` type-checks on its own. design/feedback.md requires *"`optimistic: 'none'` without
    `pending` is a type error"*. Nine commands use `'none'` with nothing else, e.g.:
    - `packages/shell/src/frame/HomeView.tsx:24` and `TaskView.tsx:34`;
    - `plugins/crew/ui/src/more/commands.ts:31,39,46,53`;
    - `plugins/stuff/ui/src/commands.ts:51`.
23. **must-fix**: `packages/shell/src/frame/HomeView.tsx:46-47`: a new task **waits for `runtime.create`'s
    answer, then navigates** (`.then((r) => navigate(openTask r.id))`). feedback.md §2 and §3 say to navigate at
    once and show the row and page in a *Starting* state. `TaskView.tsx:34,57`: a follow-up is `optimistic: 'none'`,
    so the message doesn't appear in the transcript (or the queue) until the peer answers. v1 shows it at once.
24. **must-fix**: `packages/shell/src/frame/HomeView.tsx:46,52` hard-codes `agent: 'claude'` and
    `HARNESS['claude']`, and `frame/rows-view.ts` holds a `HARNESS` table that `Sidebar.tsx:132` reads. AGENTS.md
    and ADR-0003 say the kernel and shell know no feature, with "no `harness === 'claude'` outside plugins/claude".
    The default harness and each harness's mark come from the harness plugins through an extension point.
    Relatedly, the frame's fallback `HomeView`/`TaskView`/`SidebarList` re-implement what the `shell-home`,
    `shell-task` and `shell-list` plugins own. Either the plugins draw these screens, or say in an ADR why the
    shell owns them.
25. **must-fix**: only **6 of the 40** plugins in `crates/wisp/src/groups.rs` `DEFAULT` are compiled into the binary
    (`crates/wisp/Cargo.toml` features: git, worktrees, ship, review, issues, machine). runtime, settings and every
    harness are missing, so `wisp serve` can't run a task. Also, **23 plugin hosts have no `wisp-plugin.json`
    and implement no `Plugin`**: accounts, antigravity, channels, claude, codex, connectors, copilot, cursor, discord,
    email, github, grok, lsp, mcp, ntfy, opencode, plugins, settings, slack, telegram, telemetry, terminal, update.
    `rust-manifests` only checks crates that implement `Plugin`, so it passes without checking them, and "every
    command is in a capability set" is unchecked for those 23.

**Nits**

26. **nit**: `tools/check/rules/openapi.ts` reads routes from `apps/server/src` (v1, deleted), so it checks
    nothing. The Rust edge builds `/openapi.json` from its route table (`crates/wisp-api/src/own.rs:39`), so
    routes are documented by construction. Point the rule at the Rust table, or retire it with a note.
27. **nit**: the plan coverage table says kernel "72 tests". `cargo test -p wisp-kernel` runs 64.
28. **nit**: `plugins/shell-settings/ui/src/panes/General.tsx:76-88`: the i18n rule flags `title="shell-settings.tui"`
    and 7 more. Either it's a false positive (a key handed to a component that calls `t`), so teach the rule, or
    wrap them in `t()`.
29. **nit**: 75 Rust functions over 60 lines and 25 TS components over 60 lines (warnings only).
    `cargo deny`: 11 duplicate crates (getrandom ×3, thiserror, syn, rand, bitflags…).
30. **nit**: home rows show "Finished" with a one-pixel antialias difference at the dot (`card.status`). Below the
    glyph rule, so no action unless the metric is off.

### What the coder should do first

1. Make the workspace compile (items 1–4), then clippy (6), then the 5 tests (7).
2. Restore one deterministic v1 reference (item 9) before chasing more parity.
3. Fix the layout breaks a user sees on the done screens: composer at 900 (13), turn footer (16), tip cards (15),
   heading at 320 (14), task head at 320 (17), the blank task render (5).
4. Commands: add `pending` to `CommandDef`, then make New task and follow-up answer at once (22, 23).
5. Repoint `qa/layout-areas.mjs` at the stage so the layout gate checks the app (10).
