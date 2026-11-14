// wisp.telemetry's UI: Settings → Privacy (usage stats, and the repo-trust question).
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.telemetry',
  settings: [{ id: 'privacy', group: 'advanced', title: 'telemetry.privacy.pane', icon: 'info', order: 30, component: lazy(() => import('./panes/Privacy.tsx')) }],
  catalogue,
};
export default ui;
