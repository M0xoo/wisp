# v2 round, item 3: terminal context (ADR-0023)

Edge cases were written into ADR-0023 first: 10, one named test each.

## Built

**`plugins/termctx/core` (sans-IO)**
- Sources: each is the terminal's own read command, never the user's.
  - tmux: `capture-pane -p -J -S -N -t $TMUX_PANE`;
  - WezTerm: `cli get-text --pane-id`;
  - kitty: `@ get-text`, only with remote control;
  - iTerm2 and Apple Terminal: `osascript`.
- Output: `strip_ansi` (CSI, OSC including VS Code's marks, and carriage-return overwrites) and `tail`.
- The shell hook (`hook_script` for zsh, bash and fish):
  - each command's cwd, exit code, duration and time, one JSON line in `${WISP_HOME:-~/.wisp}/term/<tty>.jsonl`;
  - the file is made with `umask 077`, and no `wisp` call runs per prompt.
- `parse_log` (7 days) and `history_tail` (zsh extended, bash, fish).
- `wants_context`: "above", "that error", "what I just ran", …
- `TermContext`: the `block()` the agent gets, which says out loud when output couldn't be read, and the `summary()` line.
- `failed_since`: the `terminal.failed` events with a cursor per tty.

**`plugins/termctx/api`**: the `termctx.source@1` point (`TermSource::argv`), `termctx.sources`, and `ENV_KEYS` (the only variables sent).

**`plugins/termctx/host` (`wisp.termctx`, in the default group)**
- The five built-in sources as contributions.
- `termctx.sources`: the read commands for the CLI's terminal, which sees only `ENV_KEYS`.
- `terminal.failed`: a poll trigger source over `<home>/term/*.jsonl`. With no hook there are no events and no failure. `match`/`project` narrow it.
- The `termctx.enabled` setting.

**CLI**
- `wisp shell-init zsh|bash|fish`.
- `wisp "<prompt>"` and `wisp run` attach the context when the prompt asks about what's above, or with `--context`.
  - `--no-context`, `WISP_NO_CONTEXT` and the setting off all win;
  - `--show-context` prints the block; `--lines N`.
- Commands come from the hook's log for this tty, or else from the shell's history file. Plus the git branch and `status --short`.
- Everything goes through share-core's scrub (secret shapes and secret env values) before the task is made.
- It prints one line: "◌ with terminal context: 3 commands, 120 lines from tmux, git status, 1 secret masked".

**Kernel fix (found by this round's manifest test)**
- Item 1 added `contributes.triggerSources` to five manifests (automations, github, issues, worktrees, termctx), but the kernel's manifest check didn't know the key.
- Those plugins would have been refused with `invalid.manifest`. The key is now known and checked: a list of source names.
- Every touched plugin's `manifest_is_valid` passes again.

**Tests, run one at a time, all passing**
- core:
  - `tmux_capture_takes_the_last_n_lines_of_this_pane`;
  - `a_terminal_without_its_api_is_skipped_not_an_error`;
  - `never_reruns_a_command_to_get_its_output`;
  - `shell_hook_log_parses_and_drops_week_old_lines`;
  - `history_files_of_zsh_bash_fish_read_their_last_commands`;
  - `prompt_about_what_is_above_attaches_context`;
  - `context_summary_says_what_was_attached`;
  - `terminal_failed_fires_once_per_failed_command`;
  - `shell_hook_writes_a_private_file`.
- CLI: `secrets_in_scrollback_are_masked_before_they_leave` and `shell_init_knows_three_shells`.
- host: `readers_see_only_the_terminal_variables` and `manifest_is_valid`.
- **By hand:** the zsh and bash hooks were run in real shells (zsh 5.9, bash 3.2). Each wrote valid JSON lines with the exit code and escapes intact, and the file was mode 600.
  - This found and fixed two bugs: zsh's `int()` needs `zsh/mathfunc` (integer locals are used instead), and with no tty the log was named `not a tty.jsonl`.
  - **fish isn't installed here, so its hook wasn't run.**

Clippy `-D warnings` is clean on wisp-termctx-api, wisp-termctx-core, wisp-termctx, wisp and wisp-kernel. `npm run check` reports 0 errors.

## What's left

- **VS Code's terminal:** there's no API to read its scrollback from outside. Its shell-integration marks are stripped from captures, but VS Code isn't a source.
- **Linking commands to their output** through the terminal's API (ADR §"the shell hook … links each command to its output"): the hook records the commands, and the capture is the whole recent pane. They aren't joined per command yet.
- **The desktop app's terminal panes** attaching the same block: that comes with the GUI.
- **TypeScript bindings** for the new wire types (here and in items 1–2): ts-rs writes them when the crates' export tests run, which is the outer loop's job. Nothing was hand-written.
