// @wisp-plugin/goal-ui: wisp.goal's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { defineExtension, definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.goal',
  // the band over an open task's turns (design/goals.md): where its goal stands, its judges, its round
  extensions: [defineExtension({ id: 'wisp.goal.band', attachTo: { id: 'shell.task:band' }, component: lazy(() => import('./Band.tsx')) })],
  views: [],
  commands: [],
  catalogue,
});
