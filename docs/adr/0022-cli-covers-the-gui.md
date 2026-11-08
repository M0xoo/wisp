# ADR-0022: Everything the GUI can do, the CLI can do

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "make the CLI even better, so a user can do whatever is possible in the GUI from their
  terminal."

## Decision

- **The CLI is generated from the command catalogue**, so it can't fall behind the GUI. Every command a
  plugin declares (its manifest + `api` types, the same ones the UI calls) is reachable as
  `wisp <plugin> <verb> [args] [--flags]`, with flags and help generated from its argument types
  (`wisp crew add --name Ada --role …`, `wisp settings set theme dark`, `wisp worktrees ls`). The user's
  capability set applies exactly as in the GUI. A plugin someone installs gets its CLI too, with no extra
  work.
- **Curated verbs stay** for the common flows (v1's `wisp "task"`, `ls`, `show`, `wait`, `reply`, `btw`,
  `stop`, `ship`, `merge`, `run`, …), built on the same commands.
- **Reads follow the topics:** `wisp <topic> --watch` streams changes the way the UI's subscription does
  (`wisp ls --watch`, `wisp show <id> --watch` follows a turn live), and `wisp attach <id>` gives a live
  view of a task in the terminal (transcript, asks and approvals answerable from the keyboard).
- **Every command prints human text by default and `--json` for scripts**, and exits non-zero on refusal,
  with the wire error's message.
- **Discoverable:** `wisp help` lists every plugin's commands, `wisp help <plugin>` its verbs, shell
  completions (`wisp completions zsh|bash|fish`) come from the same catalogue, and `wisp <thing> --help`
  shows the argument docs from the `api` crate.
- **A parity check:** a test walks the command catalogue and fails if a command the UI calls has no CLI
  path. The CLI docs page on the site is generated from the catalogue.

## Consequences

Command argument types need doc comments (they become `--help`). Interactive flows the GUI does with a
picker (choose a project, a model) get a prompt in a TTY and a flag outside one.
