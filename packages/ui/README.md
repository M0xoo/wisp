# @wisp/ui

The kit: Solid 1.9 components on Zag.js machines, and the only package with CSS (ADR-0007).

## Rules every component follows

- **No styling from outside.** `class`, `className`, `classList` and `style` are typed `never`
  (`test/no-styling.types.test.tsx` proves it in `npm run typecheck`). Looks come from token-typed props
  (`gap="4"`, `tone="bad"`, `size="sm"`). Measured values pass as CSS custom properties through `vars`
  on layout components (`vars={{ '--sb-w': '320px' }}`).
- **`data-part` is the plugin contract.** Every component renders `data-part`, defaulting to `ui.<name>`;
  the `part` prop (a namespaced `PartName`, `list.row`) replaces it. Inner elements a plugin may restyle
  are `<part>.<child>`. The kit styles itself through `data-kit`, never through `data-part`, so renaming a
  part never loses the look.
- **CSS** lives in `src/css/*.css`, imported through `@wisp/ui/kit.css`. `index.css` declares
  `@layer reset, tokens, kit, plugins;` once; every other sheet is one `@layer kit` (or `reset`) block.
  `test/css-rules.test.ts` fails on px values off the token scale (breakpoints only in queries),
  `:has()`, `:is()`, hard-coded colours and class selectors.
- **Light DOM**, keyed lists (`Key` / `VirtualList` / `Each`) so a reorder moves nodes, and entry
  animations that play once per mount.
- **Nothing wraps that shouldn't** (`design/layout.md`). Control text (button, pill, tab, menu item,
  row title, time) carries `data-text="control"`: one line, ellipsis. `Inline` never wraps and has no
  `wrap` prop; `Wrap` is the only wrapping layout. `Toolbar` takes `items` (each with `icon` and
  `priority: 'pin' | number`), stays at `--bar-h`, and folds label → icon → More as it narrows, measured by
  one ResizeObserver from a hidden copy, with one icon's width of hysteresis (`toolbar-plan.ts`).
- **No copy of its own.** Labels come from props; the few accessible names the kit must supply (Close,
  Dismiss, Loading, Send, Resize) go through `t` (`KitProvider`, or a component's `t` prop).

## Using it

```tsx
import '@wisp/ui/kit.css';
import { Stack, ListRow, Pill, Time, useSignal } from '@wisp/ui';
```

`useSignal(readable)` turns an alien-signals getter (or a `{ get, subscribe }` store) from
`@wisp/client` into a Solid accessor.

## Gallery

`npm run gallery` (port 5199): every component in every state; `?theme=light|dark`.
