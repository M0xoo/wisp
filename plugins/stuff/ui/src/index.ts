// wisp.stuff's UI: My Stuff (what you and your agents kept), opened from the sidebar.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import catalogue from './i18n/en.json' with { type: 'json' };

const ui: PluginUiDef = {
  id: 'wisp.stuff',
  catalogue,
  views: [
    { kind: 'stuff.page', slot: 'main', parse: () => null, component: lazy(() => import('./StuffPage.tsx')) as never, title: () => 'My Stuff' },
    // Make a pane (v1 pane-make.js): the head's Make a pane, ⌘K
    { kind: 'stuff.make', slot: 'overlay', overlay: 'dialog', parse: (p: unknown) => p, component: lazy(() => import('./MakePane.tsx')) as never, title: () => (catalogue as Record<string, string>)['stuff.make.title'] ?? 'Make a pane' },
  ],
};
export default ui;
