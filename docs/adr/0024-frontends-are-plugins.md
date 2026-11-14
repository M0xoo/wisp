# ADR-0024: The GUI, the TUI and the CLI are plugins over the same core

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "a TUI that mirrors what the GUI does, so users have two options" and "make sure
  everything is a plugin, so CLI, TUI and GUI are just plugins over other stuff."

## Decision

- **No frontend is special.** All three are frontend plugins over the same contracts: the command catalogue
  (every write), the topics and the sync protocol (every read), and the capability sets (what the caller may
  do).
  - **`wisp.web`**: serves the web bundle (`apps/web`, the shell and every plugin's `ui/`). It's
    the GUI in a browser, the desktop app and the phone app.
  - **`wisp.tui`** (new): `wisp tui` is a full-screen terminal app (Rust, ratatui) that mirrors the
    GUI. It has the task list with its sections, the task view with its live transcript and blocks, the
    composer with `@` mentions and `/` commands, questions and approvals, crew, My Stuff, Settings (forms
    generated from each plugin's typed settings), and the palette. It uses the same keys as the GUI where
    they exist (J/K, Enter, E, N, Esc, `[`, ⌘K → Ctrl-K).
  - **`wisp.cli`**: the command-line verbs, generated from the catalogue (ADR-0022), with terminal
    block renderers and live attach. It shares those renderers with the TUI.
- **Every frontend is a client of the sync protocol, like the phone.** The TUI and CLI attach to the local
  wisp, or to any peer (another computer, a grid box), with a cursor and the same commands. A Rust
  `SyncClient` joins the server machine in `wisp-sync`. Nothing in a frontend reads the store directly.
- **Every feature plugin contributes to each frontend through points it owns, not code the frontend owns.**
  - A plugin folder may hold `ui/` (Solid, the GUI) and `tui/` (a Rust crate `wisp-<name>-tui`, for the TUI
    and the CLI). `api/`, `core/` and `host/` stay the same.
  - Points:
    - `web.extension` / `web.view` (the shell's inputs, plan §6.6)
    - `tui.view@1` (a screen or pane)
    - `tui.input@1` (the TUI's slots, mirroring the shell's inputs)
    - `term.block@1` (a block's terminal renderer, used by both the TUI and the CLI)
    - `cli.verb@1` (a hand-written verb beyond the generated ones)
  - A plugin that contributes nothing to a frontend still works there through the generated CLI verbs, the
    generic block renderer and generated settings forms. Nothing is missing, it's only plainer.
- **Plugin groups decide which frontends ship.** `DefaultPlugins` has all three. A headless server
  (`HeadlessPlugins`) has the CLI only. A grid box has the web frontend. Each one can be switched off like
  any plugin.
- **One parity test per frontend.** It walks the catalogue and the topics, and fails if the GUI can reach
  something the TUI or the CLI can't.

## Consequences

- New dependency: `ratatui` with `crossterm`, both pinned, and recorded in ADR-0015's list.
- The TUI reuses the client-state ideas from ADR-0006 in Rust: one entity store fed by sync, navigation as
  a reducer, flows as machines.
- Plugins gain an optional `tui/` crate. The shell inputs and the TUI inputs map one to one, so a plugin's
  GUI extension and its TUI extension attach to the same named place.

## Edge cases (the TUI, `crates/wisp/src/tui/tests.rs`)

- The first snapshot selects the newest task, the top row, not the first row the snapshot gave:
  `the_list_starts_on_the_newest_task_in_its_sections`.
- Answers are rendered at the pane's real width, not at 80 columns and then wrapped again:
  `answers_wrap_at_the_panes_width_not_eighty`.
- A tool step is one line with its `+a −d` until opened. Opened, its diff is side by side when wide:
  `a_tool_step_shows_its_counts_and_opens_to_its_diff`.
- An ask takes its option's number. An approval takes `y`, `a` or `n`:
  `an_ask_is_answered_by_number_and_an_approval_by_y_a_n`.
- A follow-up shows at once. One that wisp refuses comes back to the box with a toast, so nothing typed is lost:
  `a_follow_up_shows_at_once_and_a_refused_one_comes_back`.
- A new task appears at once, selected. The real one replaces it, and a refused one goes away with a toast:
  `a_new_task_appears_at_once_and_the_real_one_replaces_it`.
- Esc on a running turn interrupts it, with one stop in flight at a time, shown on the row:
  `shift_tab_cycles_the_mode_and_esc_interrupts_a_running_turn`.
- `/` opens the command menu only in an empty box. `@` inside a word is just a letter. A pick replaces the word
  being typed: `the_composer_opens_the_at_and_slash_pickers`,
  `at_and_slash_open_their_pickers_and_a_choice_replaces_the_word`.
- A view is a `tui.view@1` table. A row action that deletes or fires asks first:
  `the_palette_goes_to_a_view_and_its_row_actions_run`.
- A plugin's `term.block@1` renderer goes ahead of the built-in one for its type, and the rest stay built-in:
  `a_plugins_block_renderer_goes_first`.
- The help is generated from the keymap, so it can't drift: `the_help_is_the_keymap`.
- Under 100 columns, one zone shows at a time: `one_zone_under_a_hundred_columns`.
- Every screen has golden snapshots at 80×24 and 160×48 (`crates/wisp/tests/goldens/tui/`):
  `goldens_at_80x24_and_160x48`.
- Every glyph that is text, on every view and in both themes, reads at 3:1 or better against its own background
  (no ghost text): `no_ghost_text_every_glyph_reads_against_its_background`.
- A frame that draws less than the one before leaves no cell of it behind (no stray characters):
  `a_redraw_leaves_nothing_of_the_frame_before`.
- The theme is `@wisp/tokens`, generated by `tools/gen-tui-theme.ts`, with rgba tokens composited over `bg`:
  `the_theme_is_wisps_tokens`.
