# UI: how wisp looks

> *wisp: quiet, neutral, out of the way. One accent, hairlines, native type.* (`web/css/tokens.css`)

The page is a tool people leave open all day next to their editor. It should read like a calm
document, not a dashboard: the agents' work is the content, wisp's chrome stays in the background.

## Tokens

All colours, shadows, radii and fonts live in `web/css/tokens.css`, defined three times: light,
`prefers-color-scheme: dark` (Theme: System) and `[data-theme='dark']`. **Add a token to all three
blocks or none.** Components use the variables only.

| Token | Use |
|---|---|
| `--bg`, `--bg-2`, `--rail` | page, hover fills / wells, side rails |
| `--surface`, `--surface-2` | cards and panels; tinted panels and form fields |
| `--ink`, `--ink-2` | main text; secondary text that must still read (open done task titles use `--ink-2`, not grey) |
| `--muted` | labels, inactive icons |
| `--faint` | times, counts, hints, placeholders. 4.5:1 (WCAG AA) even on `--bg-2`, in both themes: don't go lighter |
| `--line`, `--line-2` | 1px borders: separators / control borders |
| `--accent`, `--accent-ink`, `--accent-soft` | the one accent: focus, links, selection, the live ring |
| `--good`, `--warn`, `--bad`, `--info` | state only: done / waiting / error. Not decoration |
| `--add*`, `--del*` | diffs |
| `--pc` (`.c-violet` …) | project colours: muted, never neon, only on the project's own dot or chip |
| `--shadow-1`, `--shadow-2` | resting cards / floating menus, toasts and dialogs |
| `--sans`, `--display`, `--mono`, `--ease` | type and the one easing curve |

Colour carries meaning, not decoration: green means done/added (*Mark done* is green like
*Reopen*, #185), amber means waiting on you, red means error or destructive. A new state colour
needs a reason.

## Borders and surfaces

- Borders are plain 1px neutral lines: `var(--line)` or `var(--line-2)`.
- **No coloured side stripes**, inset accent bars or shadows that bend round corners. Question cards
  once had a 3px accent stripe that curved with the radius (#11); emphasis now goes on the full 1px
  border (`color-mix` of the state colour into the line).
- Radii: 8–11px for controls and cards (`--radius` is 10px), 99px for pills. Match the neighbours.
- Shadows only on things that float (menus, toasts, dialogs, the docked launcher).

## Type

- One scale, at most five sizes on a screen ([scorecard.md](scorecard.md), row 9): **11.5px** (times,
  counts, keys, badges, mono chips), **12.5px** (secondary: pills, sub-lines, labels), **13px** (UI:
  rows, buttons, menus), **14px** (reading: body, prompts, results, the task's title in its head) and
  one display size per screen (26px: the home greeting, a result's heading). Dialogs and the docs
  reader keep their own headings; the phone app's 15px title is its one exception. Don't add a size.
- Numbers that change in place (times, counts, elapsed) get `font-variant-numeric: tabular-nums`
  so they don't wiggle.
- Paths, commands, branches, cron, tokens: `--mono` (the form kit's `.mono`).
- Long text wraps: user prompts and answers break long URLs and unbroken words
  (`overflow-wrap: anywhere`) instead of running off the card (#264). Titles that are cut show the
  full text on hover (`title=`), and get two lines on phones.
- Short labels stay whole (`white-space: nowrap; flex: none`); the long thing next to them
  (a branch, a computer name) is the one that shrinks with `…` (`min-width: 0; text-overflow: ellipsis`).
  Badges and menu titles never break onto two lines: move the hint below instead (#255, #268).

## Buttons and controls

Use what's in `web/css/tokens.css` and `web/css/base.css`; don't style a control per component.

- `.primary` (ink fill; `.sm`), `.ghost` (`.sm`, `.xs`, `.danger`), `.icon-btn` (32×32), `.link`.
- **Form kit** (`base.css`): `.input`, `.textarea`, `select` (styled by default), `.field` (icon or
  prefix + bare input), `.check`, sizes `.sm` / `.lg`, `.mono`. Components set only layout (width,
  flex). In a panel already tinted `--surface-2`, set `--field-bg: var(--surface)`. It replaced 11
  different input styles (#25); don't start a twelfth.
- Prompt boxes (launcher, composer, rerun) and inline renames are their own borderless pattern.
- Focus: every control gets the global `:focus-visible` ring for free. If yours draws its own, it
  must be at least as visible. Never `outline: none` without a replacement.
- Disabled is `opacity` ~0.5 and `cursor: not-allowed`, not hidden, unless the action can never
  apply in that context.

## Icons

- One sprite in `web/index.html` (`<symbol id="i-name">`), drawn with `icon('name')` from
  `web/js/blocks.js` (16px, `.i`). Add new icons to the sprite **and** to `ICONS` in
  `web/js/spell-schema.js`.
- An icon must say what it does: Settings is a cog (it once looked like a theme switch, #209), No
  folder and recipes have their own icons rather than a generic sparkle.
- Icon-only buttons need `aria-label` and a `title`.

## Motion

- Short and soft: 0.12–0.3s, `var(--ease)`. Entrances are a small rise or fade (`rise`, `fade-in`,
  `pop` in `blocks.css`); nothing bounces or slides far. The one exception is a row leaving the
  list under your finger (a swipe): it flies off its own edge, then its height closes to 0 (0.2s).
- Entry animations play **once**, when a thing first appears. Re-inserting a DOM node replays them,
  so a refresh must never re-append nodes that are already in place (#57: one 👍 replayed 60
  animations). See [ux.md](ux.md#stable-layouts).
- `prefers-reduced-motion` is handled page-wide in `responsive.css`; a looping animation of your own
  (spinners, shimmer) also needs a reduced-motion rule if it's more than a small spinner.
- Live work is a 3×3 dot grid with a ripple running out from its centre (`.orb.live`), and the
  working panel's "… is working" has a soft light passing over it; waiting on you is the amber
  pulse. Don't invent another "busy" signal. (Small spinners inside buttons, like Send or Recheck,
  stay rings.)

## Dark mode

- Never hard-code `#fff`, `black` or an rgba of either: use tokens or `color-mix(in srgb, var(--ink) X%, transparent)`.
- Images, previews and embedded pages keep their own colours; frame them with `--line`.
- Check every change in both themes (Settings → Theme, or the OS setting).

## Layout widths

| Width | What changes |
|---|---|
| ≥ 900px (`SPLIT_MIN_WIDTH`) | split view side by side: the list beside the open task |
| < 900px | stacked (`body.stack`): the list, and what's open as a page over it with Back |
| ≤ 720px | phone layout: tighter top bar, labels fold to icons |
| ≤ 640 / 520px | further folds (team label, launcher chips); `@container launcher` for the box itself |
| `hover: none` + `pointer: coarse` | touch: no shortcut hints, no hover-only controls |

Prefer container queries for a component that sits in different widths (the launcher is in
split home at any width). Use `min-width: 0` on flex/grid children that hold text so they can shrink.
