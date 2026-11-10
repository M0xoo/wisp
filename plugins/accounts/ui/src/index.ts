// wisp.accounts' UI: Settings → Agents (the harnesses, their accounts, sign-ins and keys).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.accounts',
  settings: [{ id: 'agents', group: 'agents', title: 'accounts.pane', icon: 'agent', order: 10, component: lazy(() => import('./panes/Agents.tsx')) }],
  catalogue,
};
export default ui;
