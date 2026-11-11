// @wisp-plugin/learn-ui: wisp.learn's UI (v1 Settings → Memory): learn from tasks, what's remembered, the retros.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.learn',
  catalogue,
  settings: [{ id: 'memory', group: 'agents', title: 'learn.pane', icon: 'text', order: 30, component: lazy(() => import('./panes/Memory.tsx')) }],
};
export default ui;
