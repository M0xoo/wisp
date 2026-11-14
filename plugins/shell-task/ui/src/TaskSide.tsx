// `shell-task.side`: the pane open beside the task (Changes, Shell, PR, Watch), for the task it names. A plugin's
// tab (an app pinned beside tasks) is the exception: its panel stays mounted from task to task and only hears which
// task is open, so the app's frame is made once and kept (v1 panes.js paneNode: one frame per app, told the task).
import { Show, createMemo, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useSignal } from '@wisp/ui';
import { keyOf, sideOf } from './open-task.ts';
import { useShell } from './shell.ts';
import { SidePanel } from './side/SidePanel.tsx';
import { TaskProvider, createTaskContext, type TaskContext } from './task-context.tsx';

export default function TaskSide(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.client.nav.nav);
  const side = createMemo(() => sideOf(nav()));
  const key = createMemo(() => {
    const s = side();
    return s ? keyOf(shell.client, s.id) : undefined;
  });
  const tab = createMemo(() => side()?.pane === 'tab');
  // the plugin tab's context: the open task's, read through so a task switch moves it without a remount
  const ctx = createMemo((): TaskContext | undefined => {
    const k = key();
    return k && tab() ? createTaskContext(props.client, k as EntityKey) : undefined;
  });
  const live = new Proxy({} as TaskContext, { get: (_t, p) => Reflect.get(ctx() ?? {}, p) });
  return (
    <Show
      when={tab() && ctx()}
      fallback={
        <Show when={key()} keyed>
          {(k) => (
            <TaskProvider value={createTaskContext(props.client, k)}>
              <Show when={side()}>{(s) => <SidePanel pane={s().pane} {...(s().file !== undefined && { file: s().file })} />}</Show>
            </TaskProvider>
          )}
        </Show>
      }
    >
      <TaskProvider value={live}>
        <SidePanel pane="tab" />
      </TaskProvider>
    </Show>
  );
}
