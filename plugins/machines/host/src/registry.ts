// Peer rows: the one place they are read and written (through store.tx, so every change is on the
// `machines` topic). v1 kept them in config.json → machines; `fromV1` maps those entries 1:1.

import { randomBytes } from 'node:crypto';
import type { Json } from '@wisp/kernel';
import type { EntityDef, Store } from '@wisp/store';
import { PeerHttpError, type PeerRow } from '@wisp-plugin/machines-api';
import { PEER, type PeerTable } from './migrations.ts';

export const newMachineId = (): string => randomBytes(3).toString('hex');

const toRow = (t: PeerTable): PeerRow => ({
  id: t.id,
  peer: t.peer,
  name: t.name,
  transport: t.transport,
  address: t.address,
  port: t.port,
  command: t.command,
  autoConnect: t.auto_connect,
  addedAt: t.added_at,
  data: t.data as PeerRow['data'],
});

const toTable = (r: PeerRow): PeerTable => ({
  id: r.id,
  peer: r.peer,
  name: r.name,
  transport: r.transport,
  address: r.address,
  port: r.port,
  command: r.command,
  auto_connect: r.autoConnect,
  added_at: r.addedAt,
  data: r.data,
});

export class Registry {
  readonly #store: Store;
  readonly #def: EntityDef<PeerTable>;
  /** in-process copy, so request paths never query for a peer */
  #rows = new Map<string, PeerRow>();

  constructor(store: Store) {
    this.#store = store;
    this.#def = store.defineEntity<PeerTable>(PEER);
    for (const t of store.query(this.#def, { order: [['added_at', 'asc']] })) this.#rows.set(t.id, toRow(t));
  }

  all(): PeerRow[] {
    return [...this.#rows.values()];
  }

  find(id: string): PeerRow | undefined {
    return this.#rows.get(id);
  }

  get(id: string): PeerRow {
    const m = this.#rows.get(id);
    if (!m) throw new PeerHttpError('No such machine.', 404);
    return m;
  }

  /** the peer whose far side calls itself `peer` (a v2 id's origin) */
  byPeerId(peer: string): PeerRow | undefined {
    for (const m of this.#rows.values()) if (m.peer === peer) return m;
    return undefined;
  }

  put(row: PeerRow): PeerRow {
    this.#store.tx((w) => w.upsert(this.#def, toTable(row)));
    this.#rows.set(row.id, row);
    return row;
  }

  patch(id: string, fields: Partial<Omit<PeerRow, 'id'>>): PeerRow {
    const next = { ...this.get(id), ...fields };
    return this.put(next);
  }

  remove(ids: readonly string[]): void {
    this.#store.tx((w) => {
      for (const id of ids) w.del(this.#def, id);
    });
    for (const id of ids) this.#rows.delete(id);
  }
}

// ---------- v1 config.machines → rows ----------

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const GRID_FIELDS = ['grid', 'handle', 'user', 'computer', 'sandbox', 'owner'] as const;

/** One v1 machine entry: kind 'grid' with `computer` is another computer through its tunnel. */
export function fromV1(m: Record<string, unknown>, now: number): PeerRow | null {
  const id = s(m['id']);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const grid = m['kind'] === 'grid';
  const data: { [k: string]: Json } = {};
  for (const k of GRID_FIELDS) if (m[k] !== undefined && m[k] !== null) data[k] = m[k] as Json;
  const url = s(m['url']);
  const transport = !grid ? 'ssh' : typeof m['computer'] === 'string' ? 'grid-tunnel' : 'grid';
  return {
    id,
    peer: null,
    name: s(m['name'], id).slice(0, 40) || id,
    transport,
    address: grid ? url : s(m['target']),
    port: n(m['port'], grid ? (url.startsWith('http:') ? 80 : 443) : 4477),
    command: s(m['command']),
    autoConnect: m['autoConnect'] !== false,
    addedAt: n(m['addedAt'], now),
    data,
  };
}
