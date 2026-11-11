// @wisp-plugin/shell-task-ui: the open task (v1 split view's task page and side panel). The task
// view and the side panel load on first show (lazy), so the shell pays nothing until a task opens.
import { lazy } from 'solid-js';

const TaskSide = lazy(() => import('./TaskSide.tsx'));
import { defineExtension, definePluginUi } from './define.ts';
import { CATALOGUE } from './i18n/index.ts';

export { CATALOGUE };
export type * from './types.ts';


export default definePluginUi({
  id: 'wisp.shell-task',
  catalogue: { ...CATALOGUE },
  // The frame's task view is the chassis (its head renames in place, its transcript folds); this plugin fills
  // its slots: the side panel (Changes, PR, Shell), the cards under each turn, and what waits over the reply box.
  // the panel's head (its tabs) shows on every side area, so switching panes keeps it
  extensions: [
    ...(['changes', 'pr', 'shell'] as const).map((p) => defineExtension({ id: `shell-task.side.${p}`, attachTo: { id: `shell.side:${p}` }, component: TaskSide })),
    // under each turn: why it stopped, what holds it, what moved in the CLI, its receipt
    defineExtension({ id: 'shell-task.turn', attachTo: { id: 'shell.turn:foot' }, component: lazy(() => import('./cards/TurnFoot.tsx')) }),
    // over the reply box: the agent's question (or a tool's approval) and the queued follow-ups
    defineExtension({ id: 'shell-task.foot', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./foot/TaskFoot.tsx')) }),
  ],
});
