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
