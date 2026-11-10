// Settings → Machines' reads and writes: machines.add / connect / disconnect / remove (each row shows it at
// once), machines.reachable (what another computer needs to reach this one over SSH, read when the pane
// opens and on Re-check), and the grid sign-in that adds this computer (wisp.grid-client's command).
import { defineCommand, entityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';

/** Peer rows and their status rows: `{ id, body }`, on the `machines` topic. */
export const TOPIC = 'machines';
export const PEER = 'machines_peer';
export const STATUS = 'machines_status';

export interface PeerBody {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly address: string;
  readonly port: number;
  readonly addedAt: number;
}

export interface StatusBody {
  readonly id: string;
  /** off | connecting | reconnecting | online | asleep | error | incompatible */
  readonly state: string;
  readonly error: string;
}

export interface Reachability {
  readonly user: string;
  readonly hostname: string;
  readonly ssh: { readonly running: boolean; readonly banner: string; readonly port: number };
  readonly tailscale: { readonly installed: boolean; readonly running: boolean; readonly name?: string | null };
  readonly keys: number;
  readonly target: string;
  readonly supported: boolean;
}

const drop = (base: EntityReader, peer: PeerId, id: string): EntityOps => {
  const k = entityKey(peer, id);
  return base.peek(PEER, k) ? [{ e: PEER, id: k, op: 'del' }] : [];
};
const state = (base: EntityReader, peer: PeerId, id: string, s: string): EntityOps => {
  const k = entityKey(peer, id);
  const r = base.peek<{ id: string; body: StatusBody }>(STATUS, k);
  return [{ e: STATUS, id: k, op: 'upsert', v: { id, body: { ...(r?.body ?? { id, error: '' }), state: s } } }];
};

export const addMachine = defineCommand<{ peer: PeerId; name: string; address: string }>({
  id: 'machines.add',
  owner: (a) => a.peer,
  wire: (a) => ({ name: a.name, transport: 'ssh', address: a.address, autoConnect: true }),
  optimistic: 'none',
  pending: 'the Add button',
});

export const connect = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.connect', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => state(base, a.peer, a.id, 'connecting') });
export const disconnect = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.disconnect', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => state(base, a.peer, a.id, 'off') });
export const removeMachine = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.remove', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => drop(base, a.peer, a.id) });

export const reachable = defineCommand<{ peer: PeerId }, Reachability>({ id: 'machines.reachable', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the Re-check button' });
