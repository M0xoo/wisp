# Layout rules: nothing wraps that shouldn't, nothing jumps

These are hard rules for v2. The kit (`@wisp/ui`) enforces them by construction, and a test checks them in
real Chrome. Features don't get to choose, because features can't write CSS (ADR-0007).

The bugs that made these rules (2026-11-07):
- the composer's toolbar wrapped **"Full auto" onto two lines**, which made the bar taller;
- the top bar's **"81% memory · 16 running" chip pushed the avatar onto a second row**.

Both come from one cause: a bar of controls that let its text wrap, or let its row wrap, when space ran
out. In v2 a bar has a plan for running out of space, and wrapping is never that plan.

## 1. Two kinds of text, and only one of them wraps

| Kind | Examples | Wraps? | When space runs out |
|---|---|---|---|
| **Control text**: a label that belongs to a control or a fixed slot | buttons, pills, chips, tabs, menu items, toolbar labels, list-row titles, status words, times, counts, breadcrumbs, settings-row labels, badges | **Never** (`white-space: nowrap`) | it **truncates with an ellipsis** (titles), or the control **collapses to its icon** (toolbars, see §2). A count or a time is never truncated: it is the last thing to go. |
| **Content text**: what someone reads | answers, prompts, markdown, descriptions, notices, empty states, toast bodies, dialog bodies, help text | Yes, at word boundaries (`overflow-wrap: anywhere` only for code and URLs) | it wraps; long content scrolls inside its own box |

A component declares which kind each piece of its text is. Text a feature passes in can't change that:
`Button`, `Pill`, `Chip`, `Tab`, `MenuItem` and `ListRow.title` hold control text, while `Text` and
`Markdown` hold content text.

## 2. Bars never wrap their row; they collapse in a declared order

A **bar** is any single-line row of controls: the top bar, the composer's toolbar, a task's head, the
side panel's head, card footers and toolbars. In the kit that means `Toolbar`/`Bar`.

- **One line, always.** A bar's height is a token (`--bar-h`, `--bar-h-compact`), and its row never wraps
  (`flex-wrap: nowrap`). Nothing in a bar can make it taller.
- **Every item declares a priority and a collapsed form.** As the bar narrows, items step down, lowest
  priority first:
  1. **full**: icon and label ("⚙ Full auto");
  2. **icon**: the icon alone. The label moves to the tooltip and to `aria-label`, so it is never lost;
  3. **overflow**: the item moves into the bar's **More** menu (`…`), with its label.

  A label shrinks to its icon before anything moves into More. Items move into More before anything
  truncates.
- **Some items never collapse:** the primary action (Send, Stop), and the item a person is looking at
  right now (the current mode while its menu is open). Mark them `priority="pin"`.
- **Collapsing is measured, not guessed.** The kit's `Toolbar` measures with a `ResizeObserver` and
  container queries, not with viewport breakpoints, so the same toolbar works in the side panel, on a
  phone and side by side. It measures in one pass, with no layout reads after writes. It never flickers:
  hysteresis of one item's width keeps an item from flapping between forms.
- **A status chip is a control, not a sentence.** The top bar's memory chip shows `81%` plus an icon, and
  its long form ("81% memory · 16 running") lives in its tooltip and its popover. When space is tight
  the chip goes to its icon plus a coloured dot, and it never pushes another item onto a new line.

## 3. Icons instead of labels: when and how

- **Use an icon alone** for actions that are universally known in this app's context (attach, send, stop,
  close, more, search, settings, back, copy), and for any item in a bar that has collapsed (§2).
- **Use icon + label** for modes and settings whose state matters ("Full auto", "Queue"), and for the
  primary action of a dialog, as long as there is room.
- **Use a label alone** in menus, settings rows, and anywhere the words are the point.
- **Every icon-only control** has a tooltip (on hover and on long-press on a phone) and an `aria-label`
  with the full label, and a hit area of at least 32 px (44 px on a phone). `IconButton` refuses to
  render without a `label` prop (TypeScript requires it).
- An icon is never decoration that can be confused with a control. Brand marks (harness avatars) are
  `Avatar`s with a label, not `Icon`s.
- One icon per meaning, everywhere (`design/copy.md`: the same action has the same name, and the same icon).

## 4. Fixed columns, fixed widths

- In list rows, the time, the status pill and the counts sit in **fixed-width columns** (tokens), so
  selecting, opening or updating a row never shifts its neighbours. Numbers use tabular figures.
- A control whose content changes (Send ↔ Stop, a count that grows from 9 to 10, a loading state) keeps its
  width. It reserves the widest form, or uses a fixed width token, and a spinner replaces the icon, never
  the label.
- Avatars, icons and pills have token sizes, and `flex-shrink: 0`.
- A truncated title shows its full text in a tooltip, and wherever it is opened.

## 5. Wrapping a group is a layout decision, made once, in the kit

Some groups may wrap onto several lines on purpose: tag lists, attachment chips in a prompt, the blocks
of an answer, the buttons of a question block. They use `Wrap` (the kit's wrapping layout), never a
`Toolbar`. A group that has a single line in the design uses `Toolbar` or `Inline` and must never wrap.
Choosing between them is the only choice a feature makes, and it can't make the wrong one silently: the
kit's types give `Toolbar` and `Inline` no `wrap` prop.

## 6. How it's checked

- **Types:** `Toolbar`, `Inline` and `ListRow` have no wrap prop. `IconButton` requires a `label`.
  Toolbar items require `priority` and `icon`.
- **Kit CSS:** control text is `nowrap` plus an ellipsis, in `@layer kit`. `tools/check` refuses
  `flex-wrap: wrap` in kit CSS outside `Wrap`, and `white-space: normal` on a control part.
- **Layout test (real Chrome, `qa/layout.mjs`):** every screen and the kit gallery, at widths of
  1440, 1024, 900, 600, 390 and 320 px, in light and dark, with the longest labels in the i18n catalogue
  and long user content (a 200-character title, 99+ counts, `100%`). It fails when:
  - an element with `data-text="control"` spans more than one line box;
  - a `data-part` bar is taller than its token height;
  - any two items of a bar sit on different rows (their `top`s differ);
  - anything overflows the viewport horizontally;
  - a pinned item is hidden or collapsed.
- **Review:** `design/checklist.md` → *Layout*: try the screen at 320 px and at 900 px (just over the
  split point), with the side panel open.
