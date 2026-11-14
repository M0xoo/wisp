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

## The look (owner, 2026-11-09: "looks awful" on the first pass)

What failed in the first pass, never again:
- **Ghost text:** unselected rows and the prompt were drawn in near-background grey, so you could barely read them.
  Every piece of text must be readable. Use `muted` only for secondary metadata (times, project, harness), never for
  titles or content.
- **Redraw artifacts:** a stray bright character mid-line ("toggl**e**"). Draw full lines every frame through
  ratatui's buffer diff, clear the regions you shrink, and never print outside `Terminal::draw`.
- **Plain grey boxes everywhere.** Too many borders read as a spreadsheet.

The look to hit:
- **Colours from `@wisp/tokens`** (`tools/` generates a Rust theme from `packages/tokens`: `bg`, `panel`, `surface`,
  `ink`, `ink-2`, `muted`, `line`, `accent`, `good`, `warn`, `bad`, `info`, `add`, `del`, `term-*`). True colour; a
  256-colour fallback mapped by nearest. Dark and light both.
- **Few borders.** One vertical rule between the sidebar and the task, in `line`. No box around the transcript. The
  composer is the one framed thing, with rounded corners (`╭╮╰╯`), its border in `accent` when focused, `line` when not.
- **Breathing room:** 1 column of padding inside panes, 1 blank line between transcript turns, 2 spaces of indent for
  tool rows. Never text touching a border.
- **The sidebar like the GUI list:** section headers in small caps, `muted` with a count ("Needs you 4"). Each task is
  two lines: the title in `ink` (bold when unread) with its time right-aligned in `muted`, then a state dot in its
  tone colour plus harness and project in `muted`. The selected row gets a `surface` background over the full width
  and a 1-column `accent` bar on its left. Nothing wraps; long titles end in `…`.
- **The task header:** the title in bold `ink`, a state pill (tone background, `on-accent` text, 1 space of padding),
  then `project · branch · harness model` in `muted`. A thin `line` rule under it.
- **The transcript:** your prompt as a `surface` band with `›`; agent text in `ink`, wrapped to the pane width
  (`Wrap { trim: false }`, never a hard break before the edge). Tool rows: `✓` in `good`, `✗` in `bad` and a spinner in
  `accent` while running, then the verb in `ink-2`, the target in `ink` and the diff counts `+12` in `add`, `−3` in
  `del`. Answer blocks: each kind styled (hero bold with a `good`/`warn` bar, tests with coloured counts, diffs with
  `add-bg`/`del-bg` lines).
- **The status bar:** one line on `bg-2`. Left: mode pill (`plan`/`edits`/`auto` in tone colours), harness, model,
  machine. Right: `● live` in `good` (`○ offline` in `bad`), tokens and cost, then the key hints in `muted` with the
  keys in `ink`.
- **Glyphs:** `◆ ● ○ ✓ ✗ › ⋯ ↳` and the braille spinner; no Nerd Font required, with ASCII fallbacks when
  `$TERM` is dumb.

**Visual check every round:** render each view to PNG (TestBackend buffer → styled HTML → playwright-core with
the system Chrome, in /tmp, at 100×30 and 160×45, dark and light) and look at it before you hand back; attach the
PNGs to the round doc. Snapshot text goldens stay too.
