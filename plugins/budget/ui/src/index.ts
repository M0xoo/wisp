// wisp.budget's UI: Settings → Usage (the week's spend and outcomes, each plan's windows, where unattended work stops),
// the Usage view (charts and breakdowns), and Spare allowance on Home.
import { lazy } from 'solid-js';
import { defineExtension, defineView, type PluginUiDef } from '@wisp/shell';
import { VIEW_USAGE } from './views.ts';
import { catalogue, t } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.budget',
  settings: [{ id: 'usage', group: 'advanced', title: 'budget.usage.pane', icon: 'stats', order: 20, component: lazy(() => import('./panes/Usage.tsx')) }],
  views: [defineView({ kind: VIEW_USAGE, slot: 'overlay', overlay: 'dialog', parse: () => null, title: () => t('budget.view.title'), component: lazy(() => import('./UsageView.tsx')) })],
  // Spare allowance and window changes on Home, where v1 had them (.sh-spare)
  extensions: [defineExtension({ id: 'budget.spare', attachTo: { id: 'shell.home:cards' }, component: lazy(() => import('./Spare.tsx')) })],
  catalogue,
};
export default ui;
