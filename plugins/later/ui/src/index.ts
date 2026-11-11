// @wisp-plugin/later-ui: wisp.later's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { definePluginUi, defineView } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.later',
  extensions: [],
  views: [
    // a scheduled task or reminder, or a /draft, opened from its row (shell-list's Scheduled and Drafts)
    defineView<{ id?: string }>({
      kind: 'later.plan',
      slot: 'main',
      parse: (p) => (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' ? { id: (p as { id: string }).id } : {}),
      component: lazy(() => import('./ui/PlanPage.tsx')),
    }),
  ],
  commands: [],
  catalogue,
});
