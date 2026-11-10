// wisp.grid-client's UI: Settings → Cloud (sign in to a wisp Grid, this computer on it).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.grid-client',
  settings: [{ id: 'cloud', group: 'computers', title: 'grid-client.pane', icon: 'cloud', order: 20, component: lazy(() => import('./panes/Cloud.tsx')) }],
  catalogue,
};
export default ui;
