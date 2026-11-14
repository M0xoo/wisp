// wisp.connectors' UI: the Settings → Connectors pane (the MCP servers every task's agent gets).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.connectors',
  settings: [{ id: 'connectors', group: 'agents', title: 'connectors.pane', icon: 'plug', order: 15, component: lazy(() => import('./panes/Connectors.tsx')) }],
  catalogue,
};
export default ui;
