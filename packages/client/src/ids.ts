// IDs: UUIDv7 mids (time-ordered idempotency keys) and origin-prefixed entity keys (plan §7.2.1).

import type { EntityKey, PeerId } from './types.ts';

/** A UUIDv7 (RFC 9562): 48 bits of ms time, version, 74 random bits. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isPeerId(s: string): s is PeerId {
  return /^[A-Za-z0-9._-]+$/.test(s);
}

export function peerId(s: string): PeerId {
  if (!isPeerId(s)) throw new Error(`bad peer id: ${s}`);
  return s;
}

/**
 * The key a row from `peer` is stored under. New IDs already carry their origin (`laptop:…`);
 * legacy ones, imported unchanged, get it added. Nothing on the wire is rewritten.
 */
export function entityKey(peer: PeerId, id: string): EntityKey {
  return (id.startsWith(`${peer}:`) ? id : `${peer}:${id}`) as EntityKey;
}

/** The peer that owns a key, or the peer itself when given a bare peer id. */
export function ownerOf(keyOrPeer: string): PeerId {
  const i = keyOrPeer.indexOf(':');
  return peerId(i < 0 ? keyOrPeer : keyOrPeer.slice(0, i));
}
