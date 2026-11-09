# v2 round, item 6: the TUI (ADR-0024), first slice

## Built

**`wisp tui`** (`crates/wisp/src/tui/`)
- A full-screen terminal app on ratatui (approved in ADR-0024; now in ADR-0015's list, `default-features = false`, the crossterm backend).
- It's a client of the sync protocol like the CLI, sharing the CLI's sync connection (`attach::Conn`, now `pub(crate)`):
  - **the task list**, live from the runtime's list topic: newest first, archived ones left out, a state glyph each. The selection stays on its task when rows move.
  - **the selected task's last answer**, its blocks through the CLI's renderers (`term.block`: the same text `wisp show` prints). It's read again only when the list topic says that task changed. Nothing polls.
  - **a composer**: `n` starts a task (`runtime.create`) and `r` replies to the selected one (`runtime.followUp`, queued).
  - Other keys: `s` stops it (`runtime.stop`), ↑/↓ or j/k move, PgUp/PgDn scroll, `q` or Ctrl-C quits, Esc closes the composer.
- The model, `draw` and keys are pure. `run` wires them to the terminal (a key reader thread, `ratatui::init` / `restore`), the stream and the commands.

**Tests (ratatui's `TestBackend`)**
- `the_tui_lists_tasks_and_shows_the_selected_answer`;
- `keys_move_compose_and_act`;
- `a_changed_row_keeps_the_selection_on_its_task`.

## What's left

- **The plugin points:** `tui.view@1`, `tui.input@1` and `term.block@1` as points plugins contribute to (ADR-0024 §"plugins gain an optional `tui/` crate").
  - The two built-in views are hard-wired in `tui/mod.rs`.
  - `term.block` is `wisp_cli_core::Renderers`, which is a table of the built-in renderers, not yet a registry.
- **Mirroring the GUI:** the views beyond the list and the answer (transcript steps, questions with their choices, crew, automations, settings, machines) and `--on <machine>`.
  - `--on` routes commands through `machines.route`, but the sync stream it reads is still the local one, so the TUI shows this wisp's tasks.
- **A real terminal:** the TUI was checked through the test backend only. Driving it in a real terminal (tmux/expect) is the outer loop's job.

---

# Fix first: serve_code.rs, "no plugin in this wisp owns `tasks:`"

- **Cause:** the CI run (42673407031) was on a commit where `plugins/automations/host/wisp-plugin.json` already declared `triggerSources`, but the kernel's manifest check didn't know that key yet. The kernel refused the automations manifest, so the runtime's resource kinds (`tasks:` among them) were never registered.
- **Fix:** the kernel's `CONTRIB` list takes `triggerSources` and validates it. The lead committed that as f03ca7ee.
- **Checked:** `a_formula_applied_exported_and_its_workflow_run` and `atomic_apply_every_kind_history_import_and_sharing` pass, run alone (2 passed, 3.2 s).

# Item 6: the full TUI (docs/v2-tui-design.md)

## Built

**The points (`plugins/tui/api`, crate `wisp-tui-api`)**
- `tui.view@1` (`TuiView`): a screen with a source (a command or a topic), columns, row actions bound to keys (`"{/pointer}"` args filled from the row, `confirm` for ones that delete or fire), and a detail pane. `Table` declares one in a few lines.
- `tui.input@1` (`TuiInput`): a span in one of the shell's slots (status left and right, the task header), the GUI shell's inputs one to one.
- `term.block@1` (`TermBlock`): an answer block's terminal renderer, by type, with `*` as the fallback. A plugin's renderer goes ahead of the built-ins.
- `Registry` holds them; a plugin's `tui/` crate adds to it with `register(&mut Registry)`.
- **The theme** (`theme.rs`) is `@wisp/tokens`' colour values: dark, light, and a high-contrast variant. `WISP_THEME` picks one; without `COLORTERM=truecolor` every colour maps to the 256-colour cube.
- **Diffs** (`diff.rs`): a bounded LCS line diff, unified diffs parsed from a tool step's `detail`, hunks with context and `⋯` gaps, light syntax colouring. Side by side at 120 columns and up, unified when narrower.
- **Answer blocks** (`blocks.rs`): a terminal form for every block type. These are hero, markdown, steps, checklist, tests (counts and failures), diff, files and tree, stats and chart, callout, question, code and terminal, commits, compare, next and actions, and blocked, plus a `[type] text` fallback.

**The shell (`crates/wisp/src/tui/`)**
- `model.rs`: the list in the GUI's sections and the open task's transcript (session, turns and event log, with `append` handled), the ask, and the queue.
- `app.rs`: the state. Pure: keys, the mouse and pastes change it at once and return effects; command answers keep or roll back the change (`done`).
  - zones and focus, the one-zone layout under 100 columns, resizing with `[`/`]` or by dragging a border;
  - the step cursor, opening and closing a step, `1`–`9` and `y`/`a`/`n`, Esc to interrupt, Shift-Tab for the mode;
  - `/` search in the list and the transcript;
  - the palette over tasks, views, commands and settings, and `g` gotos;
  - views with their row actions and confirms;
  - the composer's send, which is optimistic: a new task gets a `local-N` row, selected, until the real one replaces it; a follow-up shows as "↑ sending" and comes back to the box if refused.
  - the queue: Alt-↑/↓ reorders it (`runtime.queue.edit`) and Ctrl-S sends one now (`runtime.queue.sendNow`);
  - `/btw`, `/fork`, `/stop`, `/help`, and `/<catalogue command> [json]`;
  - the `@` picker over tasks, crew, machines, My Stuff and files (`git ls-files`);
  - toasts, and the mouse: click, wheel, drag.
- `composer.rs`: multi-line up to 10 rows, collapsed pastes sent whole, image paths as attachments, history, `@` and `/` words, drafts per task.
- `palette.rs`: fuzzy matching. It tries each start; word starts and runs score better.
- `keys.rs`: the one keymap, which `?` shows.
- `views.rs`: the built-in views as tables over the GUI's commands. These are crew (`w` wake), automations (`f` fire with a confirm, `t` test), machines (`c` connect, `x` disconnect), My Stuff (`l` launch, `d` remove), settings, and repo history (`runtime.history`).
- `draw.rs`, the screen:
  - the sidebar with a spinner on running rows and "(stopping)" while a stop is pending;
  - the task header (title, state pill, project, branch, PR, goal, crew, and `TaskHeader` inputs);
  - the transcript, wrapped at the pane's width. The request comes first, then the steps: tools collapse to `✓ Edit src/auth.ts +1 −1 ▸` and open to the diff or output; text streams while live; then thinking, errors, blocks and notices. After that come the answer's blocks through the registry, then the ask with its choices. "↓ N more · G to follow" shows when scrolled up.
  - the side pane: changes, files, terminal, setup;
  - the queue under the composer, the composer with its cursor, and the status bar: mode, harness · model · effort, machine, tokens, cost, budget hold, branch, the inputs, and live or offline;
  - the toasts, the `?` help (two columns when it's tall and the screen is wide), the palette and the confirm.
- `mod.rs`, the run loop:
  - an input thread for keys, mouse, bracketed paste and resize, paused while `$EDITOR` has the terminal;
  - the list topic and the open task's topic (`attach::Conn`, which reconnects itself; `reconnecting()` drives the "Connection lost" banner);
  - each command in its own task, so no key waits on the network;
  - a 16 ms frame cap that redraws only when something changed or a spinner or toast is showing. ratatui diffs each frame, so there's no flicker.
- **Round-6 nits fixed:**
  - the selection starts on the newest task, the top row (it used to follow whichever row the snapshot inserted first);
  - answers render at the pane's real width (they were rendered at 80 and wrapped again).

**Tests**
- `wisp-tui-api`: 7 tests, all passing (`cargo test -p wisp-tui-api`): `a_plugins_block_renderer_goes_first`, `a_tables_cells_and_actions_read_the_row`, `the_theme_is_wisps_tokens`, `without_true_colour_every_colour_is_one_of_256`, `a_line_diff_keeps_what_stayed`, `wide_is_side_by_side_and_narrow_is_unified`, `every_answer_block_has_a_terminal_form`. One bug was caught on the way: the LCS put an added line before the line it replaced, so side by side drew them on two rows. A removed line now comes first.
- The shell has 17 tests, all passing (`cargo test -p wisp --bin wisp tui::`):
  - the 13 edge cases now listed in ADR-0024, including goldens at 80×24 and 160×48 (task, list, changes, crew and help, in `crates/wisp/tests/goldens/tui/`; `WISP_GOLDENS=update` rewrites them);
  - the mouse test, `the_mouse_picks_a_row_and_drags_a_border`;
  - the composer's three tests and the palette's one.
- `cargo clippy -p wisp-tui-api -p wisp --all-targets -- -D warnings` is clean.

## Left

- **`--on <machine>`:** the TUI's sync stream is still the local one.
- **Not built yet:**
  - the "For later" section and the Repo tab in the sidebar;
  - the blame view with a why-gutter (the history view is a table over `runtime.history`);
  - hunk jumps, and opening a file in `$EDITOR` from a diff;
  - images through kitty or iTerm2 graphics;
  - per-view goldens for automations, machines, My Stuff and settings (crew stands in for the table views).
- **Plugins' `tui/` crates:** no plugin ships one yet. The built-ins are registered through the same `Registry`.
- **The outer loop:** a real-terminal pass (tmux/expect, dark and light).

# Item 6, round 2: the look (docs/v2-tui-design.md, "The look")

The owner saw the first pass in a real Terminal and said it looked awful. The three things named:
- ghost-grey rows and prompt;
- a stray bright character after a redraw;
- grey boxes everywhere.

Each is fixed below. Every view was then looked at as PNGs, at two sizes and in both themes, and fixed until it read right.

## Built

- **The theme is generated from `@wisp/tokens`.**
  - `node tools/gen-tui-theme.ts` writes `plugins/tui/api/src/tokens.rs` from `packages/tokens/tokens/color.json`: all 47 colour tokens, dark and light. rgba tokens (`accent-soft`, `add-bg`, `del-bg`, `term-line`) are composited over the theme's `bg`, since a terminal cell has one solid colour. `--check` says when the file is stale.
  - `Theme` is built from it, with `surface`, `accent-soft`, `add-bg`, `del-bg` and `term-*` added.
  - `the_theme_is_wisps_tokens` now checks every generated token against color.json, so the two can't drift.
  - The 256-colour fallback still maps each colour to its nearest.
  - `WISP_THEME` is unchanged. Without it, a terminal that reports a light background (`COLORFGBG=…;15`) gets light.
  - `TERM=dumb` gets ASCII glyphs.
- **`draw.rs` is rewritten to the spec:**
  - **Borders:** one `│` rule in `line-2` between the sidebar, the task and the side pane. No box around anything except the composer, which is rounded, `accent` when focused and `line-2` when not.
  - **Overlays:** the palette, help and confirm use the same frame.
  - **Padding:** a column inside every pane, a blank line between turns, 2 columns of indent for tool rows. Nothing touches a rule.
  - **Sidebar, like the GUI list:**
    - `wisp` and the task count at the top;
    - section headers in caps with their count;
    - each task on two lines: the title in `ink` (bold when unread or selected) with its time right-aligned in `muted` (`2m`, `12m`, `3d`), then a state dot in its tone colour (a spinner while running) and `harness · project` in `muted`;
    - the selected task on `bg-2` across the full width, with a 1-column bar (`accent` when the list has focus);
    - long titles end in `…`;
    - clicks map screen row → task, both lines.
  - **Task header:** the title bold, a state pill (tone background, `on-accent` text, padded), then `project · branch · harness model` in `muted`, and a `line` rule.
  - **Transcript:**
    - the prompt as a `bg-2` band with `›`;
    - agent text in `ink`, wrapped to the pane;
    - tool rows: `✓` in `good`, `✗` in `bad`, or a spinner in `accent`; the verb in `ink-2`, the target in `ink`, `+12` in `add`, `−3` in `del`, and `⋯` when there's more;
    - the cursor's row on a band with the accent bar;
    - opened steps under a `↳`, with diffs on `add-bg`/`del-bg` lines;
    - the ask with `◆`, numbered choices, and the keys in `ink` with their words in `muted`.
  - **Answer blocks:** the hero has a bar in its status's tone, with the title bold and the summary in `ink-2`. The tests block colours its passed, failed and skipped counts. Diffs have tinted lines. Nothing is drawn in `faint`.
  - **Status bar:** one line on `bg-2`. Left: the mode pill (plan in `info`, edits in `warn`, auto in `good`), then harness · model · effort, machine and budget hold. Right: the inputs, tokens and cost, `● live` in `good` (or `○ offline` in `bad`), then `? keys  ^K go  q quit`.
  - **Views** (crew, automations…):
    - a title line with the action keys and a rule;
    - column heads in caps;
    - the selected row on a band with the bar;
    - columns that don't fit dropped from the right (crew at 100 columns had run past the edge);
    - the detail under a rule.
  - **Other parts:**
    - the queue sits above the composer with a blank line, and is hidden on a view;
    - toasts are rounded on `bg-2` with a tone edge;
    - the `?` help scrolls with j/k when it's taller than the screen (at 100×30 it was cut off).
  - **Glyphs** are only `◆ ● ○ ✓ ✗ › ⋯ ↳`, braille, box drawing, and `▌` for the bar. The ones that drew wide in some terminals and shifted a line (`⎇ ⏸ ▸ ▾ ■ ⊘`) are gone.
- **Redraws:**
  - each frame clears and fills the whole area, and a band pads its line to the full width, so every cell is written every frame through ratatui's buffer diff;
  - the terminal is cleared once at start;
  - nothing is printed outside `Terminal::draw`;
  - the cursor shows only in the focused composer;
  - an idle screen redraws once a minute, so the list's times age.

## Tests

- New tests:
  - `no_ghost_text_every_glyph_reads_against_its_background`: every text glyph on four views, in both themes, is at least 3:1 against its own cell's background;
  - `a_redraw_leaves_nothing_of_the_frame_before`: two frames through one terminal equal a fresh draw of the second;
  - the help-scroll case added to `the_help_is_the_keymap`;
  - the click-both-lines case added to `the_mouse_picks_a_row_and_drags_a_border`;
  - the hero, tests and diff styling cases added to `every_answer_block_has_a_terminal_form`.
- The fixtures now carry real times, harnesses and projects.
- The goldens were rewritten with `WISP_GOLDENS=update` on purpose (the look changed): `crates/wisp/tests/goldens/tui/*.txt`.
- `cargo test -p wisp --bin wisp tui::`: 20 passed. `cargo test -p wisp-tui-api`: 7 passed. `cargo clippy -p wisp-tui-api -p wisp --all-targets -- -D warnings` is clean.

## Seen (the visual check)

- `WISP_TUI_LOOK=<dir> cargo test -p wisp --bin wisp tui::tests::every_view_renders_to_html_for_the_visual_check` writes each view as styled HTML from the TestBackend buffer: every cell's colours and weight. Without that variable the test writes nothing.
- `/tmp/pw/shoot.mjs <dir>` (playwright-core in /tmp, the system Chrome by `executablePath`) turns each HTML file into a PNG. Nothing was added to the repo.
- The PNGs, 7 views × 2 sizes × 2 themes, are in `/tmp/tui-look/`: `{task,list,composer,changes,crew,help,palette}-{100x30,160x45}-{dark,light}.png`.
- Six are kept in the repo, in `docs/qa/tui/`: `task-160x45-dark.png`, `task-160x45-light.png`, `changes-160x45-dark.png`, `composer-100x30-dark.png`, `list-100x30-light.png`, `crew-100x30-dark.png`.
- Fixed after looking, before handing back:
  - the mode pill was blanked by the status bar's band;
  - the sidebar had no times;
  - section heads touched the edge;
  - the queue touched the transcript;
  - crew's columns ran past the pane at 100 columns;
  - the queue showed on views;
  - the help was cut off at 100×30.
- In the PNGs the `│` rule shows small gaps between rows. That's the browser drawing the glyph shorter than its line height; the buffer's rule is continuous, and a terminal joins it.

## Left

- A real-terminal pass (Terminal.app and iTerm2, dark and light, tmux) in the outer loop. The PNGs come from the buffer, not from a terminal's own font.
- The selected row and the prompt band use `bg-2`, not `surface`. In the tokens, light `surface` equals `bg` (#ffffff) and dark `surface` is only one step from it, so a `surface` band couldn't be seen. `bg-2` is what the GUI uses for its current row.
- Everything listed under "Left" in round 1 still stands: `--on`, For later and the Repo tab, the blame gutter, hunk jumps, terminal images.
