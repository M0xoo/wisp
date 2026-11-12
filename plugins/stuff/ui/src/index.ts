// wisp.stuff's UI: My Stuff (what you and your agents kept), opened from the sidebar.
import { lazy } from 'solid-js';
import { entityKey } from '@wisp/client';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import { taskTabs } from './panes/grant.ts';
import { PANES_KEY } from './pins.tsx';
import { ITEM, type Item } from './types.ts';
import { parseShareParams, shareable, type ShareRow } from './share/params.ts';
import catalogue from './i18n/en.json' with { type: 'json' };

const ui: PluginUiDef = {
  id: 'wisp.stuff',
  catalogue,
  views: [
    { kind: 'stuff.page', slot: 'main', parse: () => null, component: lazy(() => import('./StuffPage.tsx')) as never, title: () => 'My Stuff' },
    // Share… a task (v1 share.js shareTask): from its row menu
    {
      kind: 'stuff.share',
      slot: 'overlay',
      overlay: 'dialog',
      parse: parseShareParams,
      component: lazy(() => import('./share/ShareDialog.tsx')) as never,
      title: () => (catalogue as Record<string, string>)['stuff.share.title'] ?? 'Share task',
    },
    // Make a pane (v1 pane-make.js): the head's Make a pane, ⌘K
    {
      kind: 'stuff.make',
      slot: 'overlay',
      overlay: 'dialog',
      parse: (p: unknown) => p,
      component: lazy(() => import('./MakePane.tsx')) as never,
      title: () => (catalogue as Record<string, string>)['stuff.make.title'] ?? 'Make a pane',
    },
  ],
  // apps pinned on Home (v1 split.js .sh-panes): after Spare allowance, before the tips
  // apps pinned beside tasks (v1 panel.js "pane:<id>"): a tab each in the panel beside the open task
  sideTabs: [
    {
      id: 'wisp.stuff.panes',
      tabs: ({ client: c }) => taskTabs(c.entities.row<{ value?: unknown }>('setting', entityKey(c.home, PANES_KEY))()?.value, c.entities.list<Item>(ITEM)() as readonly Item[], (k, v) => c.t(k, v)),
      component: lazy(() => import('./TaskPane.tsx')),
    },
  ],
  extensions: [
    // Share… in a task's row menu (v1 taskMenu: shareable, a task of yours on this computer)
    defineExtension({
      id: 'wisp.stuff.rowShare',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 40,
      if: (p) => shareable(p.session?.() as ShareRow | undefined),
      bar: {
        icon: 'share',
        label: 'stuff.share.menu',
        priority: 40,
        select: (p) => p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'stuff.share' as never, params: { session: String((p.session?.() as ShareRow | undefined)?.id ?? '') } } }),
      },
    }),
    defineExtension({ id: 'wisp.stuff.homePanes', attachTo: { id: 'shell.home:cards' }, order: 50, component: lazy(() => import('./HomePanes.tsx')) }),
  ],
};
export default ui;
