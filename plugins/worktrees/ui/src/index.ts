// wisp.worktrees' UI: the Settings → Worktrees pane.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.worktrees',
  settings: [{ id: 'worktrees', group: 'computers', title: 'worktrees.pane.worktrees', icon: 'branch', order: 40, component: lazy(() => import('./panes/Worktrees.tsx')) }],
  catalogue,
};
export default ui;
