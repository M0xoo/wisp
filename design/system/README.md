# wisp design system

wisp is a page people leave open all day next to their editor: a list of coding agents' tasks,
some of which need them. It should read like a calm document, not a dashboard. The agents' work is
the content; wisp's chrome stays in the background.

> Quiet, neutral, out of the way. One accent, hairlines, native type.

This project is built from wisp's real code by `node scripts/design-system.mjs --screens` in the
wisp repo. `wisp.css` is the page's own stylesheets; `icons.svg` is its sprite; `screens/` are real
screens frozen from a running wisp. Don't edit them here: they're replaced on every sync.

## Making a prototype

1. Start from a screen in `screens/` (copy it): it already has the real layout, the list, the
   launcher and the sprite. For one part, start from its card in `preview/`.
2. Link `wisp.css` and `kit.css`, keep the sprite `<svg>` at the top of `<body>`, and use wisp's
   class names (below). New parts get new classes styled **with tokens only**, in a `<style>` block
   kept separate so it can move into `web/css/<area>.css`.
3. Show it light and dark: `<html data-theme="dark">`, or `class="wisp-dark"` on a box to show both
   themes side by side.
4. Show it side by side (1440 and 1000px) and stacked (390px, the phone). Under 900px the list fills
   the window and a task opens as a page over it with Back.
5. Use wisp's words (`guidelines/copy.md`): *task*, *New task*, *Needs you*, *Finished*, *Mark done*,
   *Rerun…*, *Ship it*, *Save for later*, *Crew*. Sentence case, buttons that say what happens.

## The parts

| Need | Use |
|---|---|
| Main action | `button.primary` (`.sm`) — ink fill, one per area |
| Other actions | `button.ghost` (`.sm`, `.xs`, `.danger`), `button.icon-btn` (32×32, `aria-label` + `title`), `a.link` |
| Inputs | the form kit: `.input`, `.textarea`, `select`, `label.field` (icon + bare input), `label.check`, `.sm` / `.lg`, `.mono` |
| Status | `.pill.st-done` / `.st-waiting` / `.st-partial` / `.st-blocked` / `.st-info` with an `<i>` dot |
| A task in the list | `article.item > .it-head > .q-dot + .it-main(.it-title, .it-sub) + .it-side(pill, logo, .q-proj, .q-time)` inside `.f-group > .f-list` |
| Busy | `.orb.live` is the only "working" signal; waiting on you is amber |
| Menus | `.menu > button` rows (icon, label, `kbd.menu-kbd`) |
| Messages | `.toast > .t-in(.t-glyph, .t-msg, .t-act, .t-x)`, at most one action |
| Needs the person | `.ask-card` (question mid-run) / `.b-question`, with `.q-head`, `.q-text`, `.q-opts > .opt` |
| Icons | `<svg class="i"><use href="#i-name"/></svg>`, 16px, names in `preview/04-icons.html`; no emoji |
| Keys | `<kbd>` |

## Rules a prototype must keep

- Tokens only (`--bg`, `--surface`, `--ink`, `--muted`, `--faint`, `--line`, `--accent`, `--good`,
  `--warn`, `--bad` …). Never a hard-coded colour, `#fff`, `black` or an rgba of them.
- Type: 11.5 / 12.5 / 13 / 14px and one display size (26px). Weight 400–600, never changed on hover.
- Borders: 1px `--line` / `--line-2`. No coloured side stripes. Shadows only on what floats.
- Radii 8–11px for controls and cards, 99px for chips.
- Motion 0.12–0.3s on `var(--ease)`; nothing bounces; a looping animation has a reduced-motion rule.
- Nothing moves when a row is hovered, selected or opened: times and pills sit in fixed columns.
- Loading shows the real shapes, never an empty box that fills in piece by piece.
- The same action has the same name everywhere: right-click menu, More, details column, ⌘K, keys.
- Phones: nothing past 390px, 44px touch targets, no hover-only controls, no keyboard hints.
- Questions, approvals and Send are never covered by a toast or a popover.
- No native `<select>` menus for pickers, no `confirm()`/`alert()`; *OK* / *Submit* / *Yes* are not labels.

The full rules are in `guidelines/` (`ui.md` look, `ux.md` behaviour, `mobile.md` phones,
`copy.md` words, `crew.md` the crew, `checklist.md` what to check before handing back).
