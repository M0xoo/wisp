// A pane keeps its topic live only while it shows, and ticks its clock on the client's scope (no
// bare timers), so closing Settings stops both.

import { createSignal, onCleanup, type Accessor } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import type { Topic } from '@wisp/protocol';

export function usePaneScope(client: PluginClient, name: string): PluginClient['scope'] {
  const scope = client.scope.child(name);
  onCleanup(() => scope.dispose());
  return scope;
}

export function useTopic(client: PluginClient, topic: Topic): void {
  client.watch(client.home, topic, usePaneScope(client, topic));
}

/** The time, a fresh value every `ms` while the pane shows. */
export function useNow(client: PluginClient, ms = 30_000): Accessor<number> {
  const scope = usePaneScope(client, 'clock');
  const [now, setNow] = createSignal(scope.timers.now());
  scope.interval(ms, () => setNow(scope.timers.now()));
  return now;
}

/** Copy to the clipboard and say "Copied" on the button for a moment (PluginClient has no toast). */
export function useCopy(client: PluginClient, ms = 1500): { copied: Accessor<boolean>; copy: (text: string) => void } {
  const scope = usePaneScope(client, 'copy');
  const [copied, setCopied] = createSignal(false);
  const copy = (text: string): void => {
    void globalThis.navigator?.clipboard?.writeText(text).then(() => {
      setCopied(true);
      scope.timeout(ms, () => setCopied(false));
    });
  };
  return { copied, copy };
}
