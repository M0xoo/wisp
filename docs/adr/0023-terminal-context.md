# ADR-0023: `wisp` in a terminal knows what just happened there

- Status: accepted
- Date: 2026-11-08
- Source: the owner: "a user in a terminal with an issue can ask wisp 'check the error above', and wisp gets
  where it was run and what was run before it."

## Context

A process can't read another process's terminal scrollback in general. But most terminals people use expose
it, and a shell hook can record the rest. So `wisp` gathers what it can, says what it got, and never runs
anything again to find out.

## Decision

- A plugin, **`wisp.termctx`**, owns a `termctx.source@1` point. Each source is one way to read recent terminal
  context, tried in order of what's detected:
  - **tmux** (`$TMUX`: `tmux capture-pane -p -S -<n>`), **WezTerm** (`wezterm cli get-text`), **kitty**
    (`kitty @ get-text`, when remote control is on), **iTerm2** (its scripting API, `$ITERM_SESSION_ID`),
    **Apple Terminal** (AppleScript `history` of the front tab), **VS Code's terminal** (shell integration
    marks);
  - **the shell hook** (`wisp shell-init zsh|bash|fish`, opt-in, added once to the rc file): records each
    command, its cwd, exit code, duration and time in `~/.wisp/term/<tty>.jsonl` (local, kept 7 days, never
    synced). With the terminal's API it also links each command to its output.
  - **always available:** the cwd, the git branch and status, the shell, the last commands from the shell's
    own history file.
- **Asking:** `wisp "check the error above"` (or `wisp --context`, or a prompt that refers to "above", "that
  error", "what I just ran") attaches a **context block** to the task: where it ran, the last commands with
  their exit codes, and the output of the failing one (last 200 lines by default, `--lines N`).
  Before sending, the CLI prints one line of what it attached ("3 commands, 120 lines from tmux, git status")
  and how to see it (`--show-context`).
- **Privacy first:** everything goes through the same secret scan and env masking as the rest of wisp (v1's
  secret-scan and env-mask rules) before it leaves the terminal. Nothing is captured unless `wisp` is run and
  asked for context, except by the opt-in shell hook, whose file stays on the machine. `--no-context` turns it
  off for one run, and a setting turns it off for good.
- **Never re-runs a command** to get its output. If the output can't be read, the context says so, and the
  agent works from the command, the exit code and the cwd.

## Consequences

Each terminal source is small and testable (a fixture of its output). New terminals are one more source,
contributed by any plugin. It works for the CLI first; the same context block can later be attached from the
desktop app's terminal panes.
