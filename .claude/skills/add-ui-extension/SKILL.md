---
name: add-ui-extension
description: Use when adding or changing any UI in wisp v2 (a screen, pane, button, chip, block renderer, setting row) so it is built from the kit, reachable by plugins, and checked in Chrome.
---

# Add UI

1. Read `design/README.md` and the design file for the area. The look is the kit's job.
2. Find the shell input it attaches to (`shell.list:top`, `shell.task:head`, `shell.composer:left`, …). If
   none fits, the owner of that area adds a new input (versioned) and every plugin can use it.
3. Build it from `@wisp/ui` components only. You may not use `class`, `style` (only `vars` with CSS custom
   properties) or CSS files. If the kit lacks something, add it to `packages/ui` in the same PR, with its
   `data-part`, its gallery entry and its tests.
4. Data: read through `@wisp/client` selectors. Write through commands with an optimistic patch. Put
   what's open in `navigate(intent)`, flows in a machine, input in drafts. A component-local signal is for
   hover or focus only.
5. Every string goes through `t('key')`, with the key in the plugin's catalogue. Every visible element a
   plugin may restyle carries a `data-part` name. Those names are frozen once released.
6. Check it in real Chrome at 1280 px and 390 px, light and dark, side by side and stacked
   (`design/checklist.md`). Use playwright-core installed in /tmp, never in the repo.
7. `.agents/bin/monoflow verify --affected` and `npm run check` pass.
