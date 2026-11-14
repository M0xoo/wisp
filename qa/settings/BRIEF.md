# Settings panes: the brief for every pane package

The lead (the Settings UI owner) built the frame, the kit pieces and a mock peer. You build the
Settings panes of one or more plugins, each in `plugins/<name>/ui` (`@wisp-plugin/<name>-ui`). The
scaffold is already there: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/i18n.ts` (typed
local `t()` over `src/i18n/en.json`), `src/source.ts` (setting adapters). Don't change those four
config files unless you must, and keep `source.ts` and `i18n.ts` verbatim (shared copies).

## Read first (in this order, quickly)

1. `AGENTS.md`, `docs/v2-team-brief.md`, `docs/v2-ui-brief.md` (rules; follow them).
2. `design/layout.md` (nothing wraps that shouldn't), `design/copy.md` (words: "plugin" replaces v1's
   "spell" in v2), `design/ui.md`, `design/checklist.md`.
3. The kit: `packages/ui/README.md`, `packages/ui/src/index.ts` and the components you use. Settings
   pieces in `packages/ui/src/settings/`: `SettingsGroup` (bordered box of rows, optional head with
   title/description/actions), `SwitchSetting` / `SelectSetting` / `ChoiceSetting` (rows bound to a
   `SettingSource`, lock-aware: pass `locked={(by) => t('<name>.locked', { by })}`), `Meter` (usage bar
   with a stop-line mark). Plus `SettingsRow` (composites), `ListRow`, `Button`, `IconButton`, `Pill`,
   `Text`, `Stack`, `Inline`, `Wrap`, `Dialog`, `Input`, `TextArea`, `Field`, `Select`, `Menu`,
   `EmptyState`, `Banner`/`Callout`, `Stats`, `Time`, `Tabs` (variant pill = segmented), `useSignal`.
4. `packages/shell/src/contract.ts` (`SettingsPaneDef`, `PluginUiDef`) and `@wisp/client`
   (`packages/client/src/index.ts`, `commands.ts` for `defineCommand`, `settings.ts`, `client.ts` for
   `PluginClient`).
5. The v1 modules and design docs named in your task, and the TS reference port of your plugin in
   `/tmp/v2ref/plugins/<name>/{api,host}` (shapes, commands, edge cases already solved). v1 server
   code in `server/` gives the JSON shapes.

## What a package exports

`src/index.ts`:

```ts
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.<name>',
  settings: [
    { id: '<pane-id>', group: '<group>', title: '<name>.pane.<pane>', icon: '<icon>', order: 10, component: lazy(() => import('./panes/<Pane>.tsx')) },
  ],
  catalogue,
};
export default ui;
```

- Pane component: `(props: { client: PluginClient }) => JSX.Element`, default export of its file.
- The frame shows the pane title (an i18n key in your catalogue) and, if your catalogue has
  `<title key>.lede`, that one-line lede under it. Don't render the title yourself.
- Pane body: a column of `SettingsGroup`s (the frame's pane already lays children out with a gap).
- Catalogue keys all start with `<name>.` (the client refuses others). Every user-facing string goes
  through `t('key')`; no literal words in JSX (npm run check flags them).
- Icons: only names in `packages/ui/src/content/icons.ts`.

## Data

- Types in **one file** `src/types.ts` (row shapes, entity kinds, topics, command arg types), taken
  from v1's JSON and the TS reference until Rust generates them. Name topics
  `plugin:wisp.<name>:<what>` and entity kinds `<name>.<thing>` (e.g. `budget.window`), keyed by a
  stable id.
- Read with `client.entities.list<T>(kind)` / `.row(kind, key)` through `useSignal` (from @wisp/ui).
  Derive with `computed` / selectors (`sortBy`, `filterBy`, `groupBy` from @wisp/client). Never copy
  server data into a signal.
- Write with commands: `defineCommand({ id, owner: (a) => <entity key or peer>, optimistic: (base, a) => [ops] })`
  in `src/commands.ts`, run with `client.run(cmd, args)`. Every write declares its optimistic patch (or
  `'none'` only when nothing on screen can change before the answer, e.g. "Copy report", a probe). The UI
  updates at once; a reject rolls back and the shell toasts it. No `fetch`, no `history`/`location`, no
  module-level `let`, no bare `setTimeout`/`setInterval` (use `client.scope` timers if you must).
- Settings: rows read the `setting` rows the config topic carries for every declared key
  (`{ key, value, locked_by }`). Use `src/source.ts`: `fromRow(client, '<key>', default)`, then
  `onOff(src, dflt)` for v1's 'on'/'off' switches or `text(src, dflt)` for enums. Keys follow the
  reference convention `<prefix>.<v1 name>` (e.g. `budget.autoStop`, `learn.learn`,
  `worktrees.worktree`); write the key list in `types.ts`.
- Opening something elsewhere: `client.navigate(intent)`. Another pane of Settings:
  `client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.settings' as ExtensionId, params: { pane: '<id>' } } })` (optional `filter` string in params reaches the pane as `props.filter`)`.
  A big list that has its own view in v1 (memory, automations, usage charts) stays summarised in the
  pane with a button that navigates to that view (`openView` with an id the owner plugin registers;
  name it `wisp.<name>.<view>` and say so in your report).
- Things PluginClient can't do yet (a success toast, copy to clipboard, watch a topic): use the kit
  (`navigator.clipboard.writeText` is fine in a click handler), show success inline (a short
  "Copied" label on the button for a moment via a signal + `client.scope` timeout), and list the gap
  in your report.

## Mock data and tests

- `test/fixtures.ts` exports `seed: SeedRow[]` (realistic rows shaped like v1's: several accounts,
  windows near limits, a locked setting, long names, 0 and many items), `handle: Handler` (your
  commands: return `{ ops }`, `refuse(code, message)` or `undefined` for commands not yours) and
  `topics: Topic[]`. Types and helpers come from `../../../../qa/settings/mock-peer.ts` (`setting()`,
  `upsert()`, `del()`, `rowOf()`, `rowsOf()`, `refuse()`, `testClient()`, `homeKey()`). The dev harness
  (`qa/settings`) loads every package's `src/index.ts` and `test/fixtures.ts` automatically.
- Tests in `test/*.test.tsx` (vitest, happy-dom): `const tc = await testClient({ seed, handle, topics, pluginId: '<name>', catalogue })`,
  mount the pane with `render` from `solid-js/web` (see `packages/ui/test/helpers.tsx`), assert what
  shows; click/act, assert the optimistic change before `tc.settle()`, and a rollback when the
  handler refuses (`tc.errors` gets the reject). Pure helpers (formatting a window, wording
  permissions, sorting) get table or property tests. Port v1's behaviours as tests (see
  `test/*.test.js` in v1 for the area, `docs/v1-edge-cases.md`).

## Gate and checks

- `npx tsc -p plugins/<name>/ui/tsconfig.json --noEmit`, `cd plugins/<name>/ui && npx vitest run`,
  `node tools/check/index.ts --quiet` (only your files must be clean), and
  `.agents/bin/monoflow verify --package=@wisp-plugin/<name>-ui` must pass.
- See it: `npx vite --config qa/settings/vite.config.ts --port <free port>` serves the frame with every
  pane on the mock peer; open `/?pane=<id>&theme=light|dark`. Check your panes in real Chrome at
  1440, 900, 390 and 320 px, light and dark (playwright-core in `/tmp/wisp-qa-pw` with the system
  Chrome, see `qa/lib.mjs`; don't add playwright to the repo). Screenshots to
  `/tmp/v2-shots/settings/<pane>-<width>-<theme>.png`. No control text on two lines, no horizontal
  overflow, nothing jumps when data changes. Fixed columns for times and pills in lists.
- Files ≤ 400 lines, functions ≤ 60. Comments say why, briefly.

## Shared worktree rules

Many agents work here at once. Touch only your packages' directories. Never run `git stash`,
`git checkout -- .`, `git reset`, `git clean`, `npm install`, `monoflow checkpoint revert|commit|ship`,
or `rm -rf` outside your directories. Don't commit. Don't edit `packages/*`, `qa/settings/*` or other
plugins: if the kit lacks something, build it from existing kit pieces and name the gap in your report.

## Report (your final message)

Per package: files, the panes (id, group, what rows/sections, which v1 behaviours each covers), types
and command ids you invented (so the Rust agents can match them), tests (count, what they prove),
gate output (tsc, vitest, check, monoflow verify), screenshots taken and what you saw, gaps/needs
from the kit, client or shell, and v1 behaviours you did not port.
