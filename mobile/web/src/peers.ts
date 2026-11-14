// Saved computers as peers. A phone has no wisp of its own, so every computer is a remote peer, all
// connected at once and merged in one store (plan §7.3.1).
//
// Peer ids: the computer's real peer id once known (the welcome says it; it is saved on the computer
// so the next start uses it), else `<kind>-<saved id>`, which is stable because the saved id never
// changes. The first welcome re-keys a computer from the derived id to the real one, once; after
// that the same wisp has the same id on every device. Two saved entries for one wisp (over SSH and
// through the grid) keep the derived id for the second, so neither replaces the other.

import { peerId, type Client, type FetchLike, type PeerConfig, type PeerId, type Scope } from '@wisp/client';
import type { Computer, NativeBridge } from './bridge.ts';
import { bridgeTransport } from './transport.ts';

// @wisp/client's own rule for a peer id (ids.ts isPeerId, not exported)
const isPeerId = (s: string): boolean => /^[A-Za-z0-9._-]+$/.test(s);

/** The client's `home`: no wisp runs on a phone, so this peer is never added. Device settings only. */
export const PHONE: PeerId = peerId('phone');

export interface PhonePeersOptions {
  fetch?: FetchLike;
}

/** The id a computer's rows and commands go under. */
export function peerOf(c: Computer): PeerId {
  if (c.peer && isPeerId(c.peer) && c.peer !== PHONE) return peerId(c.peer);
  return peerId(`${c.kind}-${c.id.replace(/[^A-Za-z0-9._-]/g, '-')}`);
}

export function peerConfig(bridge: NativeBridge, c: Computer, o: PhonePeersOptions = {}): PeerConfig {
  return { peer: peerOf(c), name: c.name, transport: bridgeTransport(bridge, c, o.fetch ? { fetch: o.fetch } : {}) };
}

/** One peer per saved computer; for `client.start`, which restores each one's saved cursor. */
export async function phonePeers(bridge: NativeBridge, computers?: readonly Computer[], o: PhonePeersOptions = {}): Promise<PeerConfig[]> {
  const list = computers ?? (await bridge.list());
  const seen = new Set<PeerId>();
  const out: PeerConfig[] = [];
  for (const c of list) {
    const cfg = peerConfig(bridge, distinct(c, seen), o);
    seen.add(cfg.peer);
    out.push(cfg);
  }
  return out;
}

// A second entry claiming a peer id already used falls back to its own derived id.
function distinct(c: Computer, taken: ReadonlySet<PeerId>): Computer {
  if (!taken.has(peerOf(c))) return c;
  const { peer: _peer, ...rest } = c;
  return rest as Computer;
}

type Client_ = Pick<Client, 'addPeer' | 'removePeer' | 'peers'>;

/**
 * Keeps the client's peers in step with the saved computers: added, forgotten, re-keyed when a
 * welcome names the real peer id. Owned by `scope`. A tunnel that comes back up skips the backoff.
 */
export function followComputers(client: Client_, bridge: NativeBridge, scope: Scope, known: readonly Computer[], o: PhonePeersOptions = {}): void {
  const current = new Map<string, { peer: PeerId; computer: Computer }>(); // by saved id
  let seen = new Set<PeerId>();
  for (const c of known) {
    const d = distinct(c, seen);
    seen.add(peerOf(d));
    current.set(c.id, { peer: peerOf(d), computer: d });
  }

  const apply = (list: readonly Computer[]): void => {
    const next = new Set(list.map((c) => c.id));
    for (const [id, e] of current) {
      if (next.has(id)) continue;
      current.delete(id);
      client.removePeer(e.peer);
    }
    seen = new Set([...current.values()].map((e) => e.peer));
    for (const raw of list) {
      const had = current.get(raw.id);
      if (had) seen.delete(had.peer);
      const c = distinct(raw, seen);
      const peer = peerOf(c);
      seen.add(peer);
      if (had?.peer === peer) {
        current.set(raw.id, { peer, computer: c });
        continue;
      }
      if (had) client.removePeer(had.peer);
      client.addPeer(peerConfig(bridge, c, o));
      current.set(raw.id, { peer, computer: c });
    }
  };

  let reloads = 0; // only the newest list applies when two reloads overlap
  const reload = (): void => {
    const mine = ++reloads;
    bridge.list().then(
      (list) => {
        if (scope.alive && mine === reloads) apply(list);
      },
      () => {}, // the bridge is gone with the page: nothing to follow
    );
  };
  scope.add(bridge.onComputers(reload));

  // The welcome names the wisp: keep it on the computer, which re-keys it through onComputers.
  scope.add(
    client.peers.onLive((peer) => {
      const entry = [...current.values()].find((e) => e.peer === peer);
      const real = client.peers.info(peer)()?.peer;
      if (!entry || !real || entry.computer.peer || real === peer || !isPeerId(real)) return;
      if ([...current.values()].some((e) => e.peer === real)) return; // that wisp is already here by another way
      bridge.save({ id: entry.computer.id, peer: real }).catch(() => {});
    }),
  );

  // Back up after a drop: connect now instead of after the client's backoff.
  scope.add(
    bridge.onTunnel((e) => {
      const entry = current.get(e.id);
      if (e.state === 'ready' && entry && client.peers.status(entry.peer)().kind === 'unreachable') void client.peers.wake(entry.peer);
    }),
  );
}
