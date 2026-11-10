// wisp.plugins' UI: Settings → Plugins (v1's Spells): every plugin and its switch.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.plugins',
  settings: [{ id: 'plugins', group: 'advanced', title: 'plugins.pane', icon: 'plug', order: 5, component: lazy(() => import('./panes/Plugins.tsx')) }],
  catalogue,
};
export default ui;
