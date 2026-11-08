# Foundation: v2 looks exactly like wisp today

The owner, 2026-11-08: *"I expect the UI to be exactly like wisp right now, EXACTLY."* And before that:
*"spacing is bad, inconsistent paddings, sloppy patterns; make the base good from the start."*

So the spec for every pixel of v2 is **v1 as it renders today**, not anyone's taste, mine included (an
earlier draft of this file invented new metrics; they're gone). The new architecture changes how the UI is
built (Solid, the kit, tokens, plugins). It changes nothing a user sees, except fixing v1 bugs that the
owner already called out (wrapping bars, `design/layout.md`).

## 1. The reference

- **`design/v1-reference/`** is captured from v1 before v1 is deleted. `qa/v1-reference.mjs` starts v1 with
  `qa/views.mjs`'s `seededWisp`, plus the stress data, and for every view in `qa/views.mjs` (the list, a task,
  its menus and panels, New task, crew, My Stuff, the palette, every Settings pane, Home) it saves:
  - screenshots at 1440, 1024, 900, 600, 390 and 320 px, in light and dark, at rest and with each
    interactive element hovered, focused and selected;
  - `metrics.json`: for every element with a v1 `PARTS` name (`web/js/spell-schema.js`), its computed box,
    padding, margin, gap, font size and line height, colours, border and radius, per width and state.
- That folder is committed and never edited by hand.

## 2. How the kit gets its numbers

- `@wisp/tokens` holds v1's tokens exactly (`web/css/tokens.css`: colours light and dark, radius, shadows,
  fonts, easing), plus v1's real spacing values as named tokens. They come from `metrics.json`, not from a
  scale someone designed.
- Each kit component's CSS reproduces the v1 element it replaces: the same paddings, gaps, heights, fonts,
  radii and states. It's written in the kit (feature CSS is still banned, ADR-0007), with the v1 selector it
  came from in a comment.
- Where v1 used one-off values for the same thing (157 distinct px values), the kit keeps the value v1
  shows **in that place**. Unifying values is a later, separate change, made only with the owner's say.

## 3. The parity gate (`qa/parity.mjs`)

The v2 mock peer is seeded with **the same data** as `seededWisp`. For every reference view, width, theme
and state:

1. **Pixel diff** against the v1 screenshot: under 0.5 % of pixels may differ (font antialiasing), and no
   differing region may be larger than 8×8 px. A failure saves the diff image to `qa/out/parity/`.
2. **Metrics diff** against `metrics.json`: every part's box, padding, gap, font and colour within ± 0.5 px
   or exactly equal.
3. Allowed differences are listed in `design/v1-reference/allowed.md`, one line each with why. Only the
   owner's own fixes go there (the wrapping bars).

A screen isn't done until it passes the gate **and** the lead has looked at the v1 and v2 screenshots side
by side, at rest, hovered and selected, at desktop and phone widths.

## 4. Rules that hold on top of v1 (the owner's fixes, already decided)

- **Nothing wraps that shouldn't** (`design/layout.md`, ADR-0012). Where v1 wrapped a bar, v2 folds
  label → icon → More instead. This is the one visible change, and it's listed in `allowed.md`.
- **Every state keeps its box.** Hover, selected, focused, running and unread change colour, never padding,
  border width or weight. A fill never touches its pane's edge if it didn't in v1, and v2 never introduces
  one that does.
- **Nothing is clipped** except by an ellipsis. Fixed columns (times, counts, pills) never clip.
- **Every action answers at once** (`design/feedback.md`): where v1 showed nothing after an action, v2 shows
  the result, navigates, or shows the control's pending state. Listed in `allowed.md`.
- **No developer words in the UI** ("plugin", "component", "mock", "not installed", ids, stack traces).
