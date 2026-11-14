// A ticking "now" for relative times, owned by the component that shows them: one interval per
// component scope, cleared when it unmounts (no bare timers, plan §4.6.8).

import { onCleanup, createSignal, type Accessor } from 'solid-js';
import type { Client } from '@wisp/client';

export function useNow(client: Client, everyMs = 30_000): Accessor<number> {
  const scope = client.scope.child('now');
  const [now, setNow] = createSignal(scope.timers.now());
  scope.interval(everyMs, () => setNow(scope.timers.now()));
  onCleanup(() => scope.dispose());
  return now;
}
