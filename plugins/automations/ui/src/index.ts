// wisp.automations' UI: Settings → Automations (recipes and the triggers that launch them).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.automations',
  settings: [{ id: 'automations', group: 'agents', title: 'automations.pane', icon: 'bolt', order: 40, component: lazy(() => import('./panes/Automations.tsx')) }],
  catalogue,
};
export default ui;
