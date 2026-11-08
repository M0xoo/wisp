# Foundation: the exact metrics every screen is built on

The owner, 2026-11-08: *"spacing is bad, inconsistent paddings, sloppy patterns. Make the base good from the
start, so features start from a good base and nothing has to be fixed later."*

This file is that base. Every number in the kit comes from here, and a test checks the rendered page
against it (`qa/layout.mjs`, rules at the end). A feature never picks a number. If a screen needs one that
isn't here, the screen is wrong, or this file gets a reviewed change first.

## 1. The grid

- **4 px base.** Every size, padding, gap and offset is a multiple of 4. The only exceptions are 1 px lines
  and 2 px focus rings.
- **Spacing scale** (`--space-N`): 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Nothing else exists.
- **Semantic spacing.** Components use these names, never raw steps:

| Token | Value | Use |
|---|---|---|
| `--gutter` | 16 | horizontal inset of every pane's content (list, task, settings, top bar, composer) |
| `--gutter-wide` | 24 | main pane on ≥ 1280 px |
| `--inset-row` | 8 | how far a row's hover/selection fill sits inside the pane (fill from 8 to w−8; text stays on `--gutter`) |
| `--gap-xs` | 4 | icon ↔ its count; dot ↔ label inside a pill |
| `--gap-sm` | 8 | items in a toolbar; avatar ↔ text; label ↔ hint |
| `--gap-md` | 12 | columns in a row; fields in a form row |
| `--gap-lg` | 16 | blocks in an answer; rows of a settings group |
| `--section` | 24 | between sections (Needs you / Working …); between settings groups |
| `--page` | 32 | top of a page to its title; between page regions |

**The one-line rule.** In every pane, the top bar's first glyph, the section headers, the row text, the
composer's text and the empty state all start on the same vertical line: `--gutter` from the pane's left
edge. Icons in bars are optically aligned to that line (the glyph's edge, not its hit box).

## 2. Type

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--text-caption` | 11 / 16 | 500 | pills, badges, kbd, column headers (uppercase never) |
| `--text-meta` | 12 / 16 | 400 | times, counts, previews, hints |
| `--text-row` | 13 / 20 | 500 | list row titles, menu items, buttons, tabs |
| `--text-body` | 14 / 22 | 400 | answers, prompts, settings descriptions, dialogs |
| `--text-title` | 16 / 24 | 600 | pane titles, task title, dialog titles |
| `--text-heading` | 20 / 28 | 600 | page headings (Settings sections, Home greeting) |
| `--text-display` | 28 / 36 | 650 | Home only |

Numbers use tabular figures everywhere. One family for UI (system), one mono. No other sizes exist.

## 3. Controls

| Size | Height | Horizontal padding | Icon | Radius | Use |
|---|---|---|---|---|---|
| `xs` | 20 | 8 | 12 | full | pills, status, chips in rows |
| `sm` | 28 | 10 | 14 | 6 | toolbar buttons, chips, inline actions |
| `md` | 32 | 12 | 16 | 6 | default buttons, inputs, selects |
| `lg` | 40 | 16 | 16 | 8 | primary actions in dialogs and empty states |

- Icon ↔ label gap: `--gap-xs` + 2 = 6 (the one non-scale value, typographic).
- Icon-only buttons are square at their height, with a hit area ≥ 32 (≥ 44 on phones, done with padding, not
  a larger glyph).
- On phones (`body.stack`), `sm` and `md` grow to 36 and 44. Fonts don't grow.

## 4. Surfaces

- Radii: 6 (controls), 8 (rows' fills, cards, menus), 12 (panels, dialogs, the composer), full (pills, avatars).
- Lines: 1 px `--line` between panes and under bars; `--line-2` for control borders. No coloured side stripes.
- Elevation: panes are flat. Only popovers, menus, dialogs, toasts and the floating composer get `--shadow-2`.
- Fills: hover `--bg-2` at 60%; selected `--bg-2`; focus is a 2 px `--accent` ring outside the shape.

## 5. Bars

- Top bar: height 48; padding-inline `--gutter`; items `sm`; gap `--gap-sm`; a 1 px `--line` below.
- Pane heads (task head, side panel head, settings head): height 48, same rules.
- Toolbars inside components (the composer's): height 32, items `sm`.
- Every bar follows `design/layout.md`: one line, items fold label → icon → More.

## 6. The list row (the most-seen element in wisp)

```
|←8→[fill ................................................................... ]←8→|
|←16→[avatar 20]←8→[title 13/20 ........… ]←12→[status 76]←8→[time 44]←16→|
|              ←8→[preview 12/16 ……… ]                                    |
```

- Height 56 (two lines: title + preview, 20 + 16, padded 10 top and bottom); phones 64.
- Columns are fixed: status **76 wide, left-aligned** (fits "Working" with its dot), time **44 wide,
  right-aligned, tabular**. They're the same x in every row, selected or not, running or not.
- Status and time sit on the **title line** (centred on its 20 px line box), never centred on the whole row.
- The title truncates with an ellipsis. The preview truncates. Nothing wraps.
- Hover and selection fill from `--inset-row` to `--inset-row`, radius 8. The text doesn't move.
- Section headers: `--text-caption` muted, height 32, on the gutter line, `--section` above.

## 7. Content panes

- Reading width: answers and transcripts max 760, centred in the main pane, with `--gutter-wide` on wide screens.
- The composer: max width 760, aligned with the reading column; radius 12; padding 12; its toolbar 32 high.
- Blocks in an answer: `--gap-lg` between them; cards inside them radius 8, padding 12.

## 8. Empty states and copy

- One 32 px icon, a `--text-title` line, at most one `--text-body` sentence (max width 360, muted), and at
  most one `lg` primary action. Centred in the pane at 40% of its height, not at the top.
- **No developer words in the UI:** never "plugin", "component", "mock", "not installed", "TODO", ids or stack
  traces. `tools/check`'s i18n catalogue lint refuses them in English strings.

## 9. Checked in real Chrome (`qa/layout.mjs`)

At 1440, 1024, 900, 600, 390 and 320 px, in light and dark, for every screen and the kit gallery:

1. Every computed `padding-*`, `margin-*`, `gap` and `inset` value in kit output is on the spacing scale.
2. Every computed `font-size`/`line-height` pair is a type token.
3. Elements marked `data-align="gutter"` in one pane share one left x (± 0.5 px).
4. In a list, every row's status column and time column share one x.
5. Status and time are vertically centred on the title's line box (± 1 px).
6. Control heights are 20/28/32/40 (36/44 on phones).
7. The layout rules of `design/layout.md` (no wrapped control text, bars one line, no horizontal overflow).

A screen isn't done until this passes **and** the lead has looked at its screenshots next to v1's.
