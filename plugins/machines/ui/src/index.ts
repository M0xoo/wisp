// wisp.machines' UI: Settings → Machines (other computers over SSH, and this one reached over SSH).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.machines',
  settings: [{ id: 'machines', group: 'computers', title: 'machines.pane', icon: 'server', order: 10, component: lazy(() => import('./panes/Machines.tsx')) }],
  catalogue,
};
export default ui;
