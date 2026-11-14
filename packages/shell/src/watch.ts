// The topics every screen shares (plan §7.2.1): the list, settings, crew, machines and stuff, from
// every peer, while the app runs. Your own wisp's are live; another computer's are passive, so
// showing its rows never wakes a sleeping box (§7.2.3) — opening one of its tasks does, through the
// task's own `session:<id>` watch. A peer added later is watched from then on; a removed one stops.

import { effect, type Client, type PeerId, type Scope } from '@wisp/client';
import type { Topic } from '@wisp/protocol';

export const CORE_TOPICS: readonly Topic[] = ['list', 'config', 'crew', 'machines', 'stuff'];

export function watchCoreTopics(client: Client, home: PeerId, owner: Scope): void {
  const per = new Map<PeerId, Scope>();
  const stop = effect(() => {
    const peers = new Set(client.peers.list()());
    for (const [peer, s] of per) {
      if (peers.has(peer)) continue;
      s.dispose();
      per.delete(peer);
    }
    for (const peer of peers) {
      if (per.has(peer)) continue;
      const s = owner.child(`watch:${peer}`);
      per.set(peer, s);
      for (const topic of CORE_TOPICS) client.peers.watch(peer, topic, s, { passive: peer !== home });
    }
  });
  owner.add(stop);
}
