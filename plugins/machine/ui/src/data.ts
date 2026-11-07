// The pane's data: the peer's snapshot row, kept live while the pane shows (watching the topic is
// what makes the peer measure), plus a clock that ticks the "Updated 20s ago" line. Everything is
// owned by a child scope of the plugin's, ended when the pane unmounts.

import { entityKey, type PeerId, type PeerStatus, type PluginClient } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { LOAD, LOAD_TOPIC, SNAPSHOT, SNAPSHOT_TOPIC, THIS, type MachineLoad, type MachineSnapshot } from './types.ts';

export interface MachineData {
  readonly peer: PeerId;
  readonly snap: Accessor<MachineSnapshot | undefined>;
  readonly status: Accessor<PeerStatus>;
  readonly now: Accessor<number>;
}

/** v1 read /machine every 10 s while the pane showed; the peer pushes at that pace now, the clock only relabels. */
const TICK_MS = 10_000;

export function useMachineData(client: PluginClient, peer: PeerId, now: () => number): MachineData {
  const owner = client.scope.child('machine.pane');
  onCleanup(() => owner.dispose());
  client.watch(peer, SNAPSHOT_TOPIC, owner);
  const snap = useSignal(client.entities.row<MachineSnapshot>(SNAPSHOT, entityKey(peer, THIS)));
  const status = useSignal(client.peers.status(peer));
  const [clock, setClock] = createSignal(now());
  owner.interval(TICK_MS, () => setClock(now()));
  return { peer, snap: snap as Accessor<MachineSnapshot | undefined>, status, now: clock };
}

/** The chip's reading: the cheap load row, passive (a sleeping box isn't woken to show a chip). */
export function useLoad(client: PluginClient, peer: PeerId): { load: Accessor<MachineLoad | undefined>; snap: Accessor<MachineSnapshot | undefined> } {
  const owner = client.scope.child('machine.chip');
  onCleanup(() => owner.dispose());
  client.watch(peer, LOAD_TOPIC, owner, { passive: true });
  const load = useSignal(client.entities.row<MachineLoad>(LOAD, entityKey(peer, THIS)));
  const snap = useSignal(client.entities.row<MachineSnapshot>(SNAPSHOT, entityKey(peer, THIS)));
  return { load: load as Accessor<MachineLoad | undefined>, snap: snap as Accessor<MachineSnapshot | undefined> };
}
