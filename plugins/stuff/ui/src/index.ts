// wisp.stuff's UI: My Stuff (what you and your agents kept), opened from the sidebar.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import catalogue from './i18n/en.json' with { type: 'json' };

const ui: PluginUiDef = {
  id: 'wisp.stuff',
  catalogue,
  views: [{ kind: 'stuff.page', slot: 'main', parse: () => null, component: lazy(() => import('./StuffPage.tsx')) as never, title: () => 'My Stuff' }],
};
export default ui;
