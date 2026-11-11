// @wisp-plugin/crew-ui: wisp.crew's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { defineExtension } from '@wisp/shell';
import { definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.crew',
  // a member's page: the main pane when a face on the rail is picked (v1 crew.js buildView)
  extensions: [defineExtension({ id: 'wisp.crew.page', attachTo: { id: 'shell.screen:crew' }, component: lazy(() => import('./CrewPage.tsx')) })],
  views: [],
  commands: [],
  catalogue,
});
