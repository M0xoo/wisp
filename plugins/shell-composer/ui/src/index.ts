// wisp.shell-composer's UI: the queued follow-ups over a task's reply box (`shell.task:foot`), with v1's
// controls (send now, edit, combine, move, cancel). The composer's other parts (pickers, mentions, slash,
// the launcher model) are its library for the screens that host a composer.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import catalogue from './i18n/en.json' with { type: 'json' };
import { PROMPT_SOURCES } from './prompt.ts';

const ui: PluginUiDef = {
  id: 'wisp.shell-composer',
  catalogue,
  // the @ and / menus of every prompt box (the shell draws them)
  prompt: PROMPT_SOURCES,
  extensions: [{ id: 'shell-composer.queue', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./ui/QueueFoot.tsx')) }],
};
export default ui;
