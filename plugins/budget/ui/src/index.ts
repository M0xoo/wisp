// wisp.budget's UI: Settings → Usage (the week's spend and outcomes, each plan's windows, where unattended work stops).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.budget',
  settings: [{ id: 'usage', group: 'advanced', title: 'budget.usage.pane', icon: 'stats', order: 20, component: lazy(() => import('./panes/Usage.tsx')) }],
  catalogue,
};
export default ui;
