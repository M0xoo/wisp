# wisp.cli

The command line as a frontend plugin (ADR-0022, ADR-0024). v1 had `bin/wisp.js`: a hand-written list of
verbs over the HTTP routes, and polling for everything that changed.

## Intent

- Everything the GUI can do, the terminal can do. Every command a plugin declares is
  `wisp <plugin> <verb> [words] [--flags]`, generated from the catalogue (`cli.catalogue`, filtered by the
  caller's capability set). Flags and `--help` come from the command's argument type and its doc comments
  (`Command::args_ts`, ts-rs's declaration). The required fields also take plain words, in order
  (`wisp settings set theme dark`). A plugin someone installs gets its verbs with no work.
- The curated v1 verbs stay on top (`wisp "task"`, `ls`, `show`, `wait`, `reply`, `btw`, `stop`, `ship`,
  `merge`, `run`, …).
- `--json` everywhere for scripts. A refusal exits 1 with the wire error's message; a command line that
  doesn't fit exits 2 and says what to type.
- Discoverable: `wisp help`, `wisp help <plugin>`, `wisp <plugin> <verb> --help`, and
  `wisp completions zsh|bash|fish` from the same catalogue.
- Starting a task never leaves you polling. In a terminal `wisp "task"` stays attached:
  - the run streams over the task's topic (wisp-sync's Rust `SyncClient`, like the phone): its steps, then
    the answer drawn by the terminal block renderers;
  - a question or an approval is asked inline (a number or your own words);
  - a reply box after the answer sends a follow-up into the same task, and a line typed while it runs is
    queued.
- Ctrl-C detaches (the task keeps running, and `wisp attach <id>` is printed); a second Ctrl-C within
  2 s stops it. `-d` returns at once with the id; outside a terminal that's the default, and `--wait`
  blocks. `wisp attach <id>`, `wisp show <id> --watch` and `wisp ls --watch` follow a task or the list
  from any terminal.
- A task this terminal left running that finished, asks or failed gets one line on the next `wisp`
  command.
- Answers render natively, never as JSON (`term.block@1`). There is one renderer for each of v1's 29
  block types, with goldens at 80 and 40 columns in colour and plain. `NO_COLOR` and pipes give plain
  text, links are OSC 8, and images show inline in iTerm2, WezTerm and kitty. A type nobody draws shows
  its title, a summary and "update wisp to see this".

## Crates

- `api`: `cli.catalogue`, the `term.block@1` point (`TermBlock`, `Style`).
- `core` (sans-IO): the TS declaration parser, verbs and help, completions, the renderers, markdown, the
  attached view (`attach::View`: topic rows in, lines and prompts out).
- `host`: the `cli.catalogue` command (the kernel's `Ctx::catalogue`).
- The IO is in the binary: `crates/wisp/src/{cli,attach}.rs`.

## Not yet

- `wisp tui` and the TUI's use of `term.block@1`.
- An OS notification for detached tasks; only the next-command notice exists today.
- Arrow-key pickers for questions; you type a number.
- Doc comments on every argument field. `cli.catalogue` reports 6 api crates whose argument types don't
  derive ts-rs yet (channels, connectors, git, ship, stuff, worktrees); their verbs take `--args JSON`.
- Attaching to another computer or a grid box: the client takes any URL, but there's no `--peer` flag yet.
