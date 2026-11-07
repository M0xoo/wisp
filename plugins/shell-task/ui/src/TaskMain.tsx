// `shell-task.main`: the open task in the main area, remounted per task (nothing of one task's view
// state reaches the next).
import { Show, createMemo, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useSignal } from '@wisp/ui';
import { openTaskKey } from './open-task.ts';
import { useShell } from './shell.ts';
import { TaskView } from './TaskView.tsx';

export default function TaskMain(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const nav = useSignal(shell.client.nav.nav);
  const key = createMemo(() => openTaskKey(shell.client, nav()));
  return (
    <Show when={key()} keyed>
      {(k) => <TaskView client={props.client} taskKey={k} />}
    </Show>
  );
}
