// The open task (v1 split view's task page): its head, the plan when it is waiting on one, and the
// transcript, which fills the rest. The composer is shell-composer's: the shell puts it under this.
import { Show, type JSX } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import { ExtensionSlot, Stack } from '@wisp/ui';
import { TaskHead } from './head/TaskHead.tsx';
import { PlanView } from './plan/PlanView.tsx';
import { useShell } from './shell.ts';
import { TaskProvider, createTaskContext, useTask } from './task-context.tsx';
import { Transcript } from './transcript/Transcript.tsx';

function Band(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const session = (): { id: string; agent: string } | undefined => {
    const t = task.task();
    return t ? { ...t, id: task.key } : undefined;
  };
  const outputs = (): { id: string; render: () => JSX.Element }[] =>
    shell.extensions('shell.task:band')().map((x) => ({ id: x.id, render: () => <x.def.component client={task.client} config={x.config} session={session} /> }));
  return (
    <Show when={outputs().length > 0}>
      <ExtensionSlot input="goal.band" layout="stack" extensions={outputs()} />
    </Show>
  );
}

export function TaskView(props: { readonly client: PluginClient; readonly taskKey: EntityKey }): JSX.Element {
  const ctx = createTaskContext(props.client, props.taskKey);
  return (
    <TaskProvider value={ctx}>
      <Stack part="split.body" gap="0" grow>
        <TaskHead />
        <Band />
        <PlanView />
        <Transcript />
      </Stack>
    </TaskProvider>
  );
}
