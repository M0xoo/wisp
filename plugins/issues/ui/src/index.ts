// @wisp-plugin/issues-ui: wisp.issues' UI (v1 issues.js): Start from an issue, the overlay New task's Issue button
// opens. It loads on first show.
import { lazy } from 'solid-js';
import { definePluginUi, defineView } from '@wisp/shell';
import { catalogue, t } from './i18n.ts';
import { parsePicker, PICKER } from './model.ts';

export default definePluginUi({
  id: 'wisp.issues',
  catalogue,
  views: [defineView({ kind: PICKER, slot: 'overlay', overlay: 'dialog', parse: parsePicker, title: () => t('issues.title'), component: lazy(() => import('./Picker.tsx')) })],
});
