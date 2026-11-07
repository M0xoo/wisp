// Ids (plan §3.1 rule 4, §4.1): UUIDv7 so ids sort by creation time, branded so a `PluginId` is not a
// `PeerId`, and origin-prefixed (`<peer>:<uuid>`) for anything that travels between peers.
import { getRandomValues } from 'node:crypto';
import type { OriginId, PeerId, PluginId } from './contract.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PEER = /^[A-Za-z0-9_-]{1,64}$/;
/** 'wisp.runtime', 'acme.thing', 'user.my-prs': two or more dot-separated segments, the first a name. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

// RFC 9562 method 1: a 12-bit counter in rand_a keeps ids made in the same millisecond in order.
let lastMs = -1;
let counter = 0;

/** A UUIDv7. `now` is injectable so a fake clock gives reproducible ordering. */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(Math.floor(now), lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) {
      ms++; // the counter ran out inside one millisecond: borrow the next one, order still holds
      counter = 0;
    }
  } else counter = 0;
  lastMs = ms;
  const rand = getRandomValues(new Uint8Array(8));
  const b = new Uint8Array(16);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b.set(rand, 8);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export const isUuidV7 = (s: unknown): s is string => typeof s === 'string' && UUID_V7.test(s);

/** The millisecond a UUIDv7 was made. */
export function uuidv7Time(id: string): number {
  if (!isUuidV7(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Builds a checked brand: `const asCrewId = brander<CrewId>('CrewId', isUuid)`. */
export function brander<T extends string>(name: string, valid: (s: string) => boolean): (s: string) => T {
  return (s: string): T => {
    if (typeof s !== 'string' || !valid(s)) throw new TypeError(`not a ${name}: ${JSON.stringify(s)}`);
    return s as T;
  };
}

export const asPluginId = brander<PluginId>('PluginId', (s) => PLUGIN_ID.test(s));
export const asPeerId = brander<PeerId>('PeerId', (s) => PEER.test(s));
export const isPluginId = (s: unknown): s is PluginId => typeof s === 'string' && PLUGIN_ID.test(s);

/** `<peer>:<uuid>`. */
export function formatOriginId(peer: PeerId | string, id: string = uuidv7()): OriginId {
  if (!PEER.test(peer)) throw new TypeError(`not a PeerId: ${JSON.stringify(peer)}`);
  if (!isUuid(id)) throw new TypeError(`not a UUID: ${JSON.stringify(id)}`);
  return `${peer}:${id}` as OriginId;
}

export function parseOriginId(s: string): { peer: PeerId; id: string } | undefined {
  const at = s.indexOf(':');
  if (at < 1) return undefined;
  const peer = s.slice(0, at);
  const id = s.slice(at + 1);
  return PEER.test(peer) && isUuid(id) ? { peer: peer as PeerId, id } : undefined;
}

/**
 * What ids a plugin owns: its id minus the author segment. 'wisp.claude' owns 'claude.*',
 * 'wisp.shell.task' owns 'shell.task.*'. The full id works too ('acme.thing.x'). The rule is the same
 * for built-ins and user plugins; collisions are refused when the second one registers.
 */
export function ownerPrefix(pluginId: string): string {
  const dot = pluginId.indexOf('.');
  return dot < 0 ? pluginId : pluginId.slice(dot + 1);
}

export function ownedBy(id: string, pluginId: string): boolean {
  const p = ownerPrefix(pluginId);
  return id === p || id.startsWith(`${p}.`) || id.startsWith(`${pluginId}.`);
}

/** 'runtime.start' owned by 'wisp.runtime' → 'start'. */
export function localName(id: string, pluginId: string): string {
  if (id.startsWith(`${pluginId}.`)) return id.slice(pluginId.length + 1);
  const p = ownerPrefix(pluginId);
  return id.startsWith(`${p}.`) ? id.slice(p.length + 1) : id;
}
