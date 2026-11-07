// @wisp-plugin/router-ui: wisp.router's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { defineExtension, definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.router',
  extensions: [defineExtension({ id: 'wisp.router.probe', attachTo: { id: 'shell.list:top' }, component: lazy(() => import('./Probe.tsx')) })],
  views: [],
  commands: [],
  catalogue,
});
