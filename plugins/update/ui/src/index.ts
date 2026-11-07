// wisp.update's UI: Settings → Updates.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.update',
  settings: [{ id: 'updates', group: 'advanced', title: 'update.pane.updates', icon: 'update', order: 10, component: lazy(() => import('./panes/Updates.tsx')) }],
  catalogue,
};
export default ui;
