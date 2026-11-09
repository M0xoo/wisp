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
  // The Changes pane is built (side/SidePanel.tsx) and attached. The main screen still isn't: TaskHead,
  // Transcript, PlanView and the cards are stubs, and an extension on `shell.screen:task` would replace the
  // frame's own task view, which works (docs/v2-round-7.md).
  // the panel's head (its tabs) shows on every side area, so switching panes keeps it; PR and Shell aren't built
  extensions: [
    ...(['changes', 'pr', 'shell'] as const).map((p) => defineExtension({ id: `shell-task.side.${p}`, attachTo: { id: `shell.side:${p}` }, component: TaskSide })),
    // over the reply box: the agent's question (or a tool's approval) and the queued follow-ups
    defineExtension({ id: 'shell-task.foot', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./foot/TaskFoot.tsx')) }),
  ],
});
