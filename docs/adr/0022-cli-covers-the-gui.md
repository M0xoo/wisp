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
- **Starting a task never leaves you polling.** In a terminal, `wisp "task"` stays attached by default and
  streams the run live from the task's topic (no polling): what the agent is doing step by step (the same
  activity lines the GUI shows), then the answer rendered for the terminal (markdown, the wisp blocks as
  text: stats, files, tests, diffs, checklists). When the agent asks a question or needs an approval, the
  CLI asks you inline and sends your answer; a reply box stays open after the answer, so you can follow up
  in the same session. **Ctrl-C detaches** (the task keeps running; the CLI prints `wisp attach <id>`), and a
  second Ctrl-C stops the run. `--detach` / `-d` returns at once with the id; outside a TTY (scripts, CI)
  the default is detached, and `--wait` blocks until the turn ends and prints the result (`--json` for the
  whole thing). A detached task that finishes, asks or fails while you're in the same terminal session says
  so (an OS notification, and a one-line notice on your next `wisp` command); `wisp ls --watch` and
  `wisp attach <id>` pick it up anytime, from any computer on your wisp.
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
