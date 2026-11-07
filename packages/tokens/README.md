# @wisp/tokens

Design tokens for wisp v2, from v1's `web/css/tokens.css` and its real px usage.

- `tokens/*.json` is the source: colour (every leaf has a light and a dark value), tone, space
  (0–9: 0, 2, 4, 6, 8, 10, 12, 16, 24, 32 px), radius, font (family, size, weight, line height,
  tracking), shadow (per theme), size, motion, z, breakpoint (`split` = `SPLIT_MIN_WIDTH` = 900).
- `npm run build` renders `dist/tokens.css` (custom properties in `@layer tokens`; dark from
  `prefers-color-scheme` unless `[data-theme]` says otherwise, and `[data-theme]` works on any element)
  and `src/generated.ts` (unions such as `Space`, `Tone`, `Radius`, `FontSize`, so a token that
  doesn't exist is a type error). Both are committed; `test/fresh.test.ts` fails when they are stale.
- Colours keep v1's variable names (`--accent`, `--ink`, `--line-2`), as do `--sans`, `--mono`,
  `--ease`, `--shadow-1/2` and `--radius`, so v1 spells imported as plugins keep resolving them.
