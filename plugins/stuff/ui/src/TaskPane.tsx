// An app from My Stuff pinned beside tasks (v1 panel.js paintPane, panes.js paneNode(it, 'task', id)): a tab in the
// panel beside the open task, named for the app ("Name: pinned from My Stuff"), showing the app in a pane that hears
// which task is open (wisp.context). Allow… asks for that task, Unpin takes the tab away (the panel goes to Changes).
import { Show, createMemo, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Pane, useTasks } from './HomePanes.tsx';
import { useEntries } from './items.ts';
import { PaneCards } from './pins.tsx';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);

export default function TaskPane(props: { readonly client: PluginClient; readonly task: string; readonly value: string }): JSX.Element {
  const c = props.client;
  const entries = useEntries(c);
  const tasks = useTasks(c);
  const entry = createMemo(() => entries().find((e) => e.it.id === props.value));
  return (
    <>
      {/* not keyed: a row update (launching sets `running`) must not remount the pane, or it launches again */}
      <Show when={entry()}>{(e) => <Pane client={c} where="task" task={bare(props.task)} entry={e()} tasks={tasks} open={false} onBack={undefined} />}</Show>
      <PaneCards client={c} />
    </>
  );
}
