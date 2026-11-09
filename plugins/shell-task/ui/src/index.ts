// @wisp-plugin/shell-task-ui: the open task (v1 split view's task page and side panel). The task
// view and the side panel load on first show (lazy), so the shell pays nothing until a task opens.
import { definePluginUi } from './define.ts';
import { CATALOGUE } from './i18n/index.ts';

export { CATALOGUE };
export type * from './types.ts';


export default definePluginUi({
  id: 'wisp.shell-task',
  catalogue: { ...CATALOGUE },
  // Not attached yet: TaskHead, Transcript, PlanView, the cards and SidePanel are still stubs (they render
  // nothing), and an extension on `shell.screen:task` replaces the frame's own task view, which works. Each
  // area gets its extension back when its screen is built (docs/v2-round-7.md):
  //   defineExtension({ id: 'shell-task.main', attachTo: { id: 'shell.screen:task' }, component: TaskMain })
  //   defineExtension({ id: 'shell-task.side.changes', attachTo: { id: 'shell.side:changes' }, component: TaskSide }) (and :shell, :pr)
  extensions: [],
});
