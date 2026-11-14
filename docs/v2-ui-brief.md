# wisp v2: brief for the agents building the UI

Read `docs/v2-team-brief.md` first; everything there applies. Then read `design/README.md`,
`design/layout.md` (**nothing wraps that shouldn't: the owner's top UI priority**), `design/ui.md`,
`design/ux.md`, `design/mobile.md`, `design/copy.md` and `design/checklist.md`, ADR-0006, ADR-0007 and
ADR-0012, plus the kit's own README (packages/ui) and its gallery.

## What you are building

v2's UI is v1's UI, screen for screen and behaviour for behaviour, rebuilt on the new architecture. The
look stays wisp's (the kit carries it). The behaviour stays v1's: read the v1 module(s) for your area in
`web/js/`, and the QA scenarios in `qa/scenarios/` for your area, before you write anything. Where v1 has a
known bug pattern (plan §4.6.1), the new state design fixes it by construction.

## Data while the Rust backend is being built

The Rust backend is being written in parallel. Until `wisp` serves `/api/events`, develop against the
**mock peer** that the shell agent builds in `apps/web/dev/mock-peer.ts`: an in-memory peer speaking the sync
protocol, seeded with realistic data shaped like v1's sessions, crew, machines and stuff, that answers
commands. Row types: use `@wisp/protocol`'s generated types once `crates/wisp-protocol` exports them
(`packages/protocol/src/generated/`); until then the shapes in v1's `server/runner.js` `summarize()` and
the TS reference (`git show v2-ts-server-reference:plugins/runtime/api/src/index.ts`) are the truth. Keep
your own type imports in one file per plugin (`src/types.ts`), so switching to generated types is one edit.

## Where the code goes

- A plugin's UI lives in `plugins/<plugin>/ui` (`@wisp-plugin/<plugin>-ui`): Solid `.tsx`, built only
  from `@wisp/ui` components. The shell's own areas are plugins too: `plugins/shell-list/ui`,
  `shell-task/ui`, `shell-composer/ui`, `shell-home/ui`, `shell-settings/ui`.
- `src/index.ts` exports the plugin's UI definition, `definePluginUi({ id, extensions: [...], views: [...],
  commands: [...], catalogue })`, from `apps/web`'s extension host (`@wisp/shell`, `packages/shell`). Each
  extension's component is `lazy(() => import('./X.tsx'))`, so a plugin costs nothing until it shows.
- package.json: name `@wisp-plugin/<plugin>-ui`, dependencies `@wisp/ui`, `@wisp/client`,
  `@wisp/shell`, `solid-js`, the plugin's own `-api` for types; scripts `test` (`vitest run
  --passWithNoTests`) and `typecheck` (`tsc -p tsconfig.json`, extending `../../../tsconfig.web.json`). Copy
  `packages/ui`'s vitest config.

## Rules (checked by `npm run check`)

- No CSS, no `class`, no `style` (only `vars` with CSS custom properties). If the kit lacks something, add it
  to `packages/ui` **in your own subfolder** `packages/ui/src/<your-area>/` with its gallery entry and tests,
  and say so in your report. Don't edit other kit files; ask in your report instead.
- Data: `client.entities` selectors to read; `defineCommand` with an optimistic patch to write; what's open
  through `navigate(intent)` only; flows as machines; input in drafts; settings in the settings store. No
  `fetch`, no `history`/`location`, no module-level `let`, no bare timers.
- Strings: `t('key')`, with keys in your plugin's catalogue (`src/i18n/en.json`).
- `data-part` names: keep v1's spell-facing part names where an element has one (`web/js/spell-schema.js`
  PARTS); the kit maps them.
- Layout: every bar is a kit `Toolbar` whose items have `priority` and `icon`; control text never wraps; rows
  use fixed columns. Phones are first-class: check at 390 px and 320 px.

## Done means

- `.agents/bin/monoflow verify --package=<each of your packages>` passes.
- Your screens run in the real app (`npm run dev:web` against the mock peer, and against the Rust `wisp`
  once it serves), and you
  checked them in real Chrome at 1440, 900, 390 and 320 px, light and dark, side by side and stacked
  (playwright-core in /tmp, system Chrome). Screenshots go in /tmp/v2-shots/<area>/, listed in your report.
- `node qa/layout.mjs --area=<area>` passes (no wrapped control text, no bar on two rows).
- Performance: a list of 5k rows scrolls with no long tasks; streaming into the open task at one token per
  16 ms costs ≤ 100 ms of scripting per 3 s on a 4×-throttled CPU. Report the numbers.
