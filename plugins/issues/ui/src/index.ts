// @wisp-plugin/issues-ui: wisp.issues' UI (v1 issues.js): Start from an issue, the overlay New task's Issue button
// opens. It loads on first show.
import { lazy } from 'solid-js';
import { definePluginUi, defineView } from '@wisp/shell';
import { catalogue, t } from './i18n.ts';
import { parsePicker, PICKER } from './model.ts';

export default definePluginUi({
  id: 'wisp.issues',
  catalogue,
  views: [defineView({ kind: PICKER, slot: 'overlay', overlay: 'dialog', bare: true, place: 'top', parse: parsePicker, title: () => t('issues.title'), component: lazy(() => import('./Picker.tsx')) })],
  // ⌘K's Actions, right after New task (v1 commands.js): the picker, for the launcher's project
  palette: [
    {
      id: 'issues.palette',
      order: 29.5,
      items: (ctx) => [
        {
          id: 'issues.start',
          group: 'shell.palette.group.actions',
          label: t('issues.palette'),
          icon: 'issue',
          keywords: 'github linear jira issue ticket bug new task launch',
          run: () => ctx.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: PICKER as never, params: { project: '', name: '' } } }),
        },
      ],
    },
  ],
});
