// @wisp-plugin/router-ui: wisp.router's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.router',
  // the scaffold's probe (a row count, Probe.tsx) isn't attached: it showed users a debug pill over the list
  extensions: [],
  views: [],
  commands: [],
  catalogue,
});
