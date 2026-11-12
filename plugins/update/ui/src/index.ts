// wisp.update's UI: Settings → Updates.
import { lazy } from 'solid-js';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.update',
  settings: [{ id: 'updates', group: 'advanced', title: 'update.pane.updates', icon: 'update', order: 10, component: lazy(() => import('./panes/Updates.tsx')) }],
  // the channel at the end of General too, where v1 had it
  extensions: [defineExtension({ id: 'update.general', attachTo: { id: 'shell.settings:general' }, component: lazy(() => import('./GeneralRow.tsx')) })],
  catalogue,
};
export default ui;
