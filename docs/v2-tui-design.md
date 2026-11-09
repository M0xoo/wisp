# wisp tui: what it has to be (owner, 2026-11-09)

The first slice (list + last answer + composer, `docs/v2-round-6.md`) is a start, not the product. The bar is the
best terminal apps for agents and dev work: opencode and Claude Code for the conversation, lazygit and k9s for
navigation. We take their interaction patterns and build them in wisp's own look (`@wisp/tokens` colours, wisp's
words), never a copy of their screens. It mirrors the GUI (ADR-0024): anything the app can do, the TUI can do.

## Layout
- **Three zones, resizable:** sessions sidebar (sections like the GUI list: Needs you, Running, For later, Done,
  Repo tab for `.wisp/` projects), the task (transcript), and a side pane that toggles (changes / files / terminal /
  setup). Collapses to one zone under 100 columns; works at 80×24.
- **Status bar:** harness + model + effort, mode (plan / edits / auto, cycled with Shift-Tab), machine (`--on`),
  tokens and cost of the turn, budget hold, branch, connection state.
- **Header per task:** title, state pill, project, branch, PR, goal progress, crew member.

## The conversation (opencode / Claude Code bar)
- **Live streaming:** text appears as it arrives; tool calls stream as rows with a spinner, then collapse to one
  line (`✓ Edit src/auth.ts +12 −3`), expandable with Enter or a click.
- **Diffs inline and in the side pane:** syntax-highlighted, side-by-side when wide, unified when narrow; jump
  between hunks, open the file in `$EDITOR`.
- **Answer blocks rendered for real:** hero, steps, tests (pass/fail counts, failures listed), diff, files, stats,
  callouts, checklists, questions as selectable options, `term.block` renderers from plugins.
- **Asks and approvals inline:** the question with its choices; keys `1`–`4`, `y` allow, `a` always allow, `n` deny.
- **Interrupt with Esc**, queue follow-ups while it runs (shown under the composer, reorder, Send now).

## The composer (Claude Code bar)
- Multi-line, grows to 10 lines; Enter sends, Shift-Enter / Alt-Enter newline; Ctrl-E opens `$EDITOR`.
- `@` fuzzy picker: files, tasks, My Stuff, crew members, machines. `/` menu: every catalogue command
  (`/goal`, `/btw`, `/fork`, `/ship`, `/model`, `/agent`…), generated, so plugins' commands appear.
- Paste of large text collapses to `[pasted 240 lines]`; dropped image paths become attachments.
- History with ↑ in an empty box; drafts kept per task (the drafts store).

## Navigation (lazygit / k9s bar)
- **Command palette** (Ctrl-K or `:`): fuzzy over tasks, commands, settings, views.
- Vim keys and arrows everywhere; `/` search in a list or transcript; `?` key help overlay generated from bindings.
- Mouse: click, scroll, drag the pane borders.
- Views for everything the GUI has: crew, automations (triggers and their deliveries), machines and the computer
  pane, My Stuff, settings, repo history and `wisp blame` with a why-gutter.

## Feel
- No flicker: diffed redraws only, 60 fps cap while streaming, nothing blocks the input thread.
- Instant feedback on every key (ADR-0017): optimistic rows, pending states.
- Themes from `@wisp/tokens` (dark, light, high contrast), true colour with a 256-colour fallback.
- Toasts for errors and rollbacks; a connection banner when the stream drops and resumes.
- Images through kitty / iTerm2 graphics when the terminal supports them, else a link.

## Built as plugins (ADR-0024)
`tui.view@1`, `tui.input@1`, `term.block@1` are real points; each feature plugin may ship a `tui/` crate. The core
TUI is the shell: zones, focus, palette, keymap, theme.

## Checked how
ratatui `TestBackend` snapshots for every view at 80×24 and 160×48 (goldens), plus a real terminal pass in the final
verification (tmux or expect) at desktop terminal sizes, dark and light.
