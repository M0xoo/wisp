// @wisp-plugin/shell-task-ui: the open task (v1 split view's task page and side panel). The task
// view and the side panel load on first show (lazy), so the shell pays nothing until a task opens.
import { lazy } from 'solid-js';
import { defineExtension, definePluginUi } from './define.ts';
import { CATALOGUE } from './i18n/index.ts';

export { CATALOGUE };
export type * from './types.ts';

const TaskMain = lazy(() => import('./TaskMain.tsx'));
const TaskSide = lazy(() => import('./TaskSide.tsx'));

export default definePluginUi({
  id: 'wisp.shell-task',
  catalogue: { ...CATALOGUE },
  extensions: [
    // the open task fills the main area when nav.main is a task (an override by id swaps it)
    defineExtension({ id: 'shell-task.main', attachTo: { id: 'shell.app:main' }, component: TaskMain }),
    // its pane (Changes, Shell, PR, Watch) beside it when nav.side names this task
    defineExtension({ id: 'shell-task.side', attachTo: { id: 'shell.app:side' }, component: TaskSide }),
  ],
});
