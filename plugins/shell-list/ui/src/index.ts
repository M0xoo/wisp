// @wisp-plugin/shell-list-ui: the task list in the sidebar (v1's feed and rows, on the kit). It fills
// `shell.sidebar:list`, the area the frame renders, and loads on first show (lazy).
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi } from '@wisp/shell';
import en from './i18n/en.json' with { type: 'json' };

export type * from './types.ts';

export const CATALOGUE: Readonly<Record<string, string>> = en;

const TaskList = lazy(() => import('./ui/TaskList.tsx').then((m) => ({ default: m.TaskList })));

export default definePluginUi({
  id: 'wisp.shell-list',
  catalogue: { ...CATALOGUE },
  extensions: [defineExtension({ id: 'shell-list.list', attachTo: { id: 'shell.sidebar:list' }, component: TaskList })],
});
