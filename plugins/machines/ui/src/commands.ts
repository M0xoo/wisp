// Settings → Machines' reads and writes: machines.add / connect / disconnect / remove (each row shows it at
// once), machines.reachable (what another computer needs to reach this one over SSH, read when the pane
// opens and on Re-check), and the grid sign-in that adds this computer (wisp.grid-client's command).
import type { Found, StatusLike } from './view.ts';
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
  readonly command?: string;
  readonly autoConnect?: boolean;
  /** the transport's own fields (a sandbox's `sandbox` id and `owner`) */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface StatusBody extends StatusLike {
  readonly id: string;
  /** off | connecting | reconnecting | online | asleep | error | incompatible */
  readonly state: string;
  readonly error: string;
}

/** What `machines.list` adds to a row: the version Update brings it to, its working tasks, the connection's log. */
export interface PeerView {
  readonly id: string;
  readonly outdated?: string | null;
  readonly working: number;
  readonly log: readonly string[];
  readonly defaultCommand: string;
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

export interface MachineForm {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly command: string;
  readonly autoConnect: boolean;
}

export const addMachine = defineCommand<{ peer: PeerId } & MachineForm>({
  id: 'machines.add',
  owner: (a) => a.peer,
  wire: (a) => ({ name: a.name, transport: 'ssh', address: a.address, port: a.port, command: a.command, autoConnect: a.autoConnect }),
  optimistic: 'none',
  pending: 'the Add button',
});

export const connect = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.connect', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => state(base, a.peer, a.id, 'connecting') });
export const disconnect = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.disconnect', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => state(base, a.peer, a.id, 'off') });
export const removeMachine = defineCommand<{ peer: PeerId; id: string }>({ id: 'machines.remove', owner: (a) => a.peer, wire: (a) => ({ id: a.id }), optimistic: (base, a) => drop(base, a.peer, a.id) });

export const reachable = defineCommand<{ peer: PeerId }, Reachability>({ id: 'machines.reachable', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the Re-check button' });

export const updateMachine = defineCommand<{ peer: PeerId; id: string } & MachineForm>({
  id: 'machines.update',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id, name: a.name, address: a.address, port: a.port, command: a.command, autoConnect: a.autoConnect }),
  optimistic: 'none',
  pending: 'the Save button',
});

/** Stop wisp there, or restart it as this version (Restart wisp there, Update to X). */
export const stopMachine = defineCommand<{ peer: PeerId; id: string; restart: boolean }>({
  id: 'machines.stop',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id, restart: a.restart }),
  optimistic: (base, a) => state(base, a.peer, a.id, a.restart ? 'connecting' : 'off'),
});

/** The password, once, so this computer's key is let in there; never kept. */
export const letIn = defineCommand<{ peer: PeerId; id: string; password: string }, { ok: boolean }>({
  id: 'machines.letIn',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id, password: a.password }),
  optimistic: 'none',
  pending: 'the Let me in button',
});

export const discover = defineCommand<{ peer: PeerId }, Found[]>({ id: 'machines.discover', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'Computers wisp found' });
export const listMachines = defineCommand<{ peer: PeerId }, PeerView[]>({ id: 'machines.list', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the machine cards' });
