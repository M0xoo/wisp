// wisp.accounts' UI: Settings → Agents (the harnesses, their accounts, sign-ins and keys).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.accounts',
  // a signed-out harness's sign-in in the harness · model picker (v1 runner-picker.js paintSignIn)
  extensions: [
    { id: 'accounts.runner-signin', attachTo: { id: 'shell.runner:signin' }, component: lazy(() => import('./panes/SignInHere.tsx')) },
    // a cloud computer's agents, signed in to from Settings → Cloud (v1 cloud.js agents); the machine's peer as `id`
    { id: 'accounts.machine-agents', attachTo: { id: 'shell.machine:agents' }, component: lazy(() => import('./panes/MachineAgents.tsx')) },
  ],
  settings: [{ id: 'agents', group: 'agents', title: 'accounts.pane', icon: 'agent', order: 10, component: lazy(() => import('./panes/Agents.tsx')) }],
  catalogue,
};
export default ui;
