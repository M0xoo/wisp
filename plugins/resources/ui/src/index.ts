// @wisp-plugin/resources-ui: wisp.resources' UI (ADR-0034): Settings → Setup (your setup as code: Share setup and
// Import). It loads on first show.
import { lazy } from 'solid-js';
import { definePluginUi } from '@wisp/shell';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.resources',
  catalogue,
  settings: [{ id: 'setup', group: 'advanced', title: 'resources.pane', icon: 'text', order: 90, component: lazy(() => import('./Setup.tsx')) }],
});
