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
