// wisp.stuff's UI: My Stuff (what you and your agents kept), opened from the sidebar.
import { lazy } from 'solid-js';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import catalogue from './i18n/en.json' with { type: 'json' };

const ui: PluginUiDef = {
  id: 'wisp.stuff',
  catalogue,
  views: [
    { kind: 'stuff.page', slot: 'main', parse: () => null, component: lazy(() => import('./StuffPage.tsx')) as never, title: () => 'My Stuff' },
    // Make a pane (v1 pane-make.js): the head's Make a pane, ⌘K
    { kind: 'stuff.make', slot: 'overlay', overlay: 'dialog', parse: (p: unknown) => p, component: lazy(() => import('./MakePane.tsx')) as never, title: () => (catalogue as Record<string, string>)['stuff.make.title'] ?? 'Make a pane' },
  ],
  // apps pinned on Home (v1 split.js .sh-panes): after Spare allowance, before the tips
  extensions: [defineExtension({ id: 'wisp.stuff.homePanes', attachTo: { id: 'shell.home:cards' }, order: 50, component: lazy(() => import('./HomePanes.tsx')) })],
};
export default ui;
