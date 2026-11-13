// wisp.machines' UI: Settings → Machines (other computers over SSH, and this one reached over SSH), and Machines in
// the top bar (v1 #machinesBtn), both opening the same Machines dialog; and the cloud computers in Settings → Cloud.
import { lazy } from 'solid-js';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.machines',
  settings: [{ id: 'machines', group: 'computers', title: 'machines.pane', icon: 'server', order: 10, component: lazy(() => import('./panes/Machines.tsx')) }],
  extensions: [
    defineExtension({ id: 'machines.bar', attachTo: { id: 'shell.topbar:machines' }, component: lazy(() => import('./TopButton.tsx')), bar: { icon: 'server', label: 'machines.title', priority: 30 } }),
    // Settings → Cloud's cloud computers (v1 .cg-list), under the account
    defineExtension({ id: 'machines.cloud', attachTo: { id: 'shell.settings:cloud' }, component: lazy(() => import('./panes/CloudComputers.tsx')) }),
  ],
  catalogue,
};
export default ui;
