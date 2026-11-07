// @wisp-plugin/goal-ui: wisp.goal's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.goal',
  extensions: [],
  views: [],
  commands: [],
  catalogue,
});
