// wisp.settings' UI: Settings → All settings (the registry every plugin declares into).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.settings',
  settings: [{ id: 'all', group: 'advanced', title: 'settings.pane', icon: 'settings', order: 90, component: lazy(() => import('./panes/All.tsx')) }],
  catalogue,
};
export default ui;
