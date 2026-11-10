// Settings → Cloud's writes: sign in (a device code the browser approves), cancel it, sign out, and this
// computer on the grid or off. The row (`grid-client.cloud`, id `this`) shows each at once.
import { defineCommand, entityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';

export const KIND = 'grid-client.cloud';
export const TOPIC = 'plugin:wisp.grid-client:cloud';
export const DEFAULT_GRID = 'grid.trywisp.dev';

export interface Computer {
  readonly on: boolean;
  /** off | connecting | online | retrying | gone */
  readonly state: string;
  readonly label: string;
  readonly url: string;
  readonly error: string;
}

export interface SignIn {
  readonly id: string;
  readonly grid: string;
  /** waiting | done | denied | expired | failed | cancelled */
  readonly state: string;
  readonly userCode: string;
  readonly verifyUrl: string;
  readonly error: string;
  readonly handle: string;
}

export interface CloudRow {
  readonly signedIn: boolean;
  readonly grid: string;
  readonly handle: string;
  readonly machine: string;
  readonly computer: Computer | null;
  readonly signin: SignIn | null;
}

const change = (base: EntityReader, peer: PeerId, fn: (r: CloudRow) => Partial<CloudRow>): EntityOps => {
  const id = entityKey(peer, 'this');
  const r = base.peek<CloudRow>(KIND, id);
  return r ? [{ e: KIND, id, op: 'upsert', v: { ...r, ...fn(r) } }] : [];
};

/** The grid's address as typed: `grid.trywisp.dev` means https. */
export const gridUrl = (typed: string): string => {
  const t = typed.trim() || DEFAULT_GRID;
  return /^https?:\/\//.test(t) ? t : `https://${t}`;
};

export const signIn = defineCommand<{ peer: PeerId; grid: string }, SignIn>({
  id: 'grid-client.signin',
  owner: (a) => a.peer,
  wire: (a) => ({ grid: gridUrl(a.grid) }),
  optimistic: 'none',
  pending: 'the Sign in button',
});

export const cancelSignIn = defineCommand<{ peer: PeerId; id: string }>({
  id: 'grid-client.signinCancel',
  owner: (a) => a.peer,
  wire: (a) => ({ id: a.id }),
  optimistic: (base, a) => change(base, a.peer, () => ({ signin: null })),
});

export const signOut = defineCommand<{ peer: PeerId }>({
  id: 'grid-client.signout',
  owner: (a) => a.peer,
  wire: () => ({}),
  optimistic: (base, a) => change(base, a.peer, () => ({ signedIn: false, handle: '', machine: '' })),
});

export const setComputer = defineCommand<{ peer: PeerId; on: boolean }>({
  id: 'grid-client.computer',
  owner: (a) => a.peer,
  wire: (a) => ({ on: a.on }),
  optimistic: (base, a) => change(base, a.peer, (r) => ({ computer: r.computer ? { ...r.computer, on: a.on, state: a.on ? 'connecting' : 'off' } : null })),
});
