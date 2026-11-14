// Auto's view row, kept live while a screen shows it (the subscription belongs to the screen).

import { onCleanup, type Accessor } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import { viewKey } from './commands.ts';
import { KIND, TOPIC, type RouterView } from './types.ts';

export function useRouterView(client: PluginClient): Accessor<RouterView | undefined> {
  const scope = client.scope.child('router.view');
  onCleanup(() => scope.dispose());
  client.watch(client.home, TOPIC.view, scope);
  const row = useSignal(client.entities.row<RouterView>(KIND.view, viewKey(client.home)));
  return row as Accessor<RouterView | undefined>;
}

/** "Claude Code" for 'claude', from the arms Auto knows; the id when it knows none. */
export function agentNamer(view: RouterView | undefined): (agent: string) => string {
  return (agent) => {
    const a = view?.arms.find((x) => x.agent === agent);
    return a ? (a.label.split(' · ')[0] ?? agent) : agent;
  };
}
