// `shell-task.side`: the pane open beside the task (Changes, Shell, PR, Watch), for the task it names.
import { Show, createMemo, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useSignal } from '@wisp/ui';
import { keyOf, sideOf } from './open-task.ts';
import { useShell } from './shell.ts';
import { SidePanel } from './side/SidePanel.tsx';
import { TaskProvider, createTaskContext } from './task-context.tsx';

export default function TaskSide(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.client.nav.nav);
  const side = createMemo(() => sideOf(nav()));
  const key = createMemo(() => {
    const s = side();
    return s ? keyOf(shell.client, s.id) : undefined;
  });
  return (
    <Show when={key()} keyed>
      {(k) => (
        <TaskProvider value={createTaskContext(props.client, k)}>
          <Show when={side()}>{(s) => <SidePanel pane={s().pane} />}</Show>
        </TaskProvider>
      )}
    </Show>
  );
}
