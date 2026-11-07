// router.json → rows (plan §4.8): the router's tables, read once at activation into RouterState and
// written back, only what changed, in one store transaction per change (v1 rewrote the whole file).
// Every row is on the `router` topic: Settings → Auto subscribes to it instead of v1's 'router' event.

import { TOPIC } from '@wisp-plugin/router-api';
import type { StoredRoute } from '@wisp-plugin/router-api';
import { importFiles } from '@wisp/store';
import type { EntityDef, Migration, Store, Writer } from '@wisp/store';
import { RouterState } from './state.ts';
import type { ArmState, Pair, Stat, Taste } from './state.ts';

export const OWNER = 'wisp.router';

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE router_arm (key TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
         CREATE TABLE router_stat (id TEXT PRIMARY KEY, a REAL NOT NULL, b REAL NOT NULL, n INTEGER NOT NULL, usd REAL NOT NULL, usd_n INTEGER NOT NULL, ms REAL NOT NULL, at INTEGER NOT NULL) STRICT;
         CREATE TABLE router_route (id TEXT PRIMARY KEY, key TEXT NOT NULL, type TEXT NOT NULL, r REAL, at INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
         CREATE INDEX router_route_at ON router_route (at);
         CREATE TABLE router_taste (id TEXT PRIMARY KEY, n REAL NOT NULL, at INTEGER NOT NULL, raw TEXT NOT NULL) STRICT;
         CREATE TABLE router_pair (id INTEGER PRIMARY KEY, type TEXT NOT NULL, auto TEXT NOT NULL, chose TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
         CREATE TABLE router_cool (target TEXT PRIMARY KEY, until INTEGER NOT NULL, why TEXT NOT NULL) STRICT;
         CREATE TABLE router_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
  },
];

type ArmRow = { key: string; first_seen: number; state: string };
type StatRow = { id: string; a: number; b: number; n: number; usd: number; usd_n: number; ms: number; at: number };
type RouteRow = { id: string; key: string; type: string; r: number | null; at: number; data: unknown };
type TasteRow = { id: string; n: number; at: number; raw: unknown };
type PairRow = { id?: number; type: string; auto: string; chose: string; at: number };
type CoolRow = { target: string; until: number; why: string };
type MetaRow = { key: string; value: string };

export interface Entities {
  arm: EntityDef<ArmRow>;
  stat: EntityDef<StatRow>;
  route: EntityDef<RouteRow>;
  taste: EntityDef<TasteRow>;
  pair: EntityDef<PairRow>;
  cool: EntityDef<CoolRow>;
  meta: EntityDef<MetaRow>;
}

const topics = (): readonly [typeof TOPIC] => [TOPIC];

export function defineEntities(store: Store): Entities {
  return {
    arm: store.defineEntity<ArmRow>({ kind: 'router.arm', table: 'router_arm', key: 'key', columns: { key: 'text', first_seen: 'int', state: 'text' }, topics }),
    stat: store.defineEntity<StatRow>({ kind: 'router.stat', table: 'router_stat', key: 'id', columns: { id: 'text', a: 'real', b: 'real', n: 'int', usd: 'real', usd_n: 'int', ms: 'real', at: 'int' }, topics }),
    route: store.defineEntity<RouteRow>({ kind: 'router.route', table: 'router_route', key: 'id', columns: { id: 'text', key: 'text', type: 'text', r: 'real', at: 'int', data: 'text' }, json: ['data'], topics }),
    taste: store.defineEntity<TasteRow>({ kind: 'router.taste', table: 'router_taste', key: 'id', columns: { id: 'text', n: 'real', at: 'int', raw: 'text' }, json: ['raw'], topics }),
    pair: store.defineEntity<PairRow>({ kind: 'router.pair', table: 'router_pair', key: 'id', columns: { id: 'int', type: 'text', auto: 'text', chose: 'text', at: 'int' }, topics }),
    cool: store.defineEntity<CoolRow>({ kind: 'router.cool', table: 'router_cool', key: 'target', columns: { target: 'text', until: 'int', why: 'text' }, topics }),
    meta: store.defineEntity<MetaRow>({ kind: 'router.meta', table: 'router_meta', key: 'key', columns: { key: 'text', value: 'text' }, topics }),
  };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const armStateOf = (v: unknown): ArmState['state'] => (v === 'new' || v === 'gone' ? v : 'ready');
const tasteOf = (v: unknown): Taste => {
  const x = obj(v);
  return { n: num(x['n']), at: num(x['at']), raw: Object.fromEntries(Object.entries(obj(x['raw'])).map(([k, n]) => [k, num(n)])) };
};
const statOf = (v: unknown): Stat => {
  const x = obj(v);
  return { a: num(x['a']), b: num(x['b']), n: num(x['n']), usd: num(x['usd']), usdN: num(x['usdN']), ms: num(x['ms']), at: num(x['at']) };
};
const routeOf = (v: unknown): StoredRoute => {
  const x = obj(v);
  return { ...x, key: String(x['key'] ?? ''), type: String(x['type'] ?? '*'), at: num(x['at']), signals: obj(x['signals']), r: typeof x['r'] === 'number' ? x['r'] : null };
};

/** Everything the router knows, from its rows. */
export function load(store: Store, e: Entities): RouterState {
  const st = new RouterState();
  for (const r of store.query(e.arm)) st.arms.set(r.key, { firstSeen: r.first_seen, state: armStateOf(r.state) });
  for (const r of store.query(e.stat)) st.setStat(r.id, { a: r.a, b: r.b, n: r.n, usd: r.usd, usdN: r.usd_n, ms: r.ms, at: r.at });
  for (const r of store.query(e.route, { order: [['at', 'asc']] })) st.routes.set(r.id, routeOf(r.data));
  for (const r of store.query(e.taste)) st.setTaste(r.id, tasteOf({ n: r.n, at: r.at, raw: r.raw }));
  st.pairs = store.query(e.pair, { order: [['id', 'asc']] }).map((r) => ({ ...(r.id !== undefined && { id: r.id }), type: r.type, auto: r.auto, chose: r.chose, at: r.at }));
  for (const r of store.query(e.cool)) st.cooling.set(r.target, { until: r.until, why: r.why });
  const b = store.get(e.meta, 'backfilled')?.value;
  st.backfilled = b ? Number(b) : null;
  return st;
}

/** Writes what changed since the last flush, in one transaction; nothing when nothing did. */
export function flush(store: Store, e: Entities, st: RouterState): void {
  const d = st.dirty;
  if (!d.arms.size && !d.stats.size && !d.routes.size && !d.taste.size && !d.cooling.size && !d.pairs.length && !d.dropPairs.length && !d.meta) return;
  store.tx((w) => writeDirty(w, e, st));
}

function writeDirty(w: Writer, e: Entities, st: RouterState): void {
  const d = st.dirty;
  for (const k of d.arms) {
    const a = st.arms.get(k);
    if (a) w.upsert(e.arm, { key: k, first_seen: a.firstSeen, state: a.state });
    else w.del(e.arm, k);
  }
  for (const k of d.stats) {
    const s = st.stats.get(k);
    if (s) w.upsert(e.stat, { id: k, a: s.a, b: s.b, n: s.n, usd: s.usd, usd_n: s.usdN, ms: s.ms, at: s.at });
    else w.del(e.stat, k);
  }
  for (const id of d.routes) {
    const r = st.routes.get(id);
    if (r) w.upsert(e.route, { id, key: r.key, type: r.type, r: r.r, at: r.at, data: r });
    else w.del(e.route, id);
  }
  for (const k of d.taste) {
    const t = st.taste.get(k);
    if (t) w.upsert(e.taste, { id: k, n: t.n, at: t.at, raw: t.raw });
    else w.del(e.taste, k);
  }
  for (const k of d.cooling) {
    const c = st.cooling.get(k);
    if (c) w.upsert(e.cool, { target: k, until: c.until, why: c.why });
    else w.del(e.cool, k);
  }
  for (const id of d.dropPairs) w.del(e.pair, id);
  if (d.pairs.length) {
    const stored = w.append(e.pair, d.pairs.map((p): PairRow => ({ type: p.type, auto: p.auto, chose: p.chose, at: p.at })));
    d.pairs.forEach((p: Pair, i) => {
      const id = stored[i]?.id;
      if (id !== undefined) p.id = id;
    });
  }
  if (d.meta) {
    if (st.backfilled) w.upsert(e.meta, { key: 'backfilled', value: String(st.backfilled) });
    else w.del(e.meta, 'backfilled');
  }
  for (const s of [d.arms, d.stats, d.routes, d.taste, d.cooling]) s.clear();
  d.pairs = [];
  d.dropPairs = [];
  d.meta = false;
}

/** v1's ~/.wisp/router.json, as rows: once, and again only if v1 rewrote the file (dual-write release). */
export async function importV1(store: Store, e: Entities, home: string, signal?: AbortSignal): Promise<void> {
  await importFiles(store, {
    name: 'router.v1',
    dir: home,
    pattern: (name) => name === 'router.json',
    ...(signal && { signal }),
    handle: (file, w) => importState(store, w, e, obj(file.json())),
  });
}

function importState(store: Store, w: Writer, e: Entities, s: Record<string, unknown>): void {
  for (const [key, a] of Object.entries(obj(s['arms']))) w.upsert(e.arm, { key, first_seen: num(obj(a)['firstSeen']), state: armStateOf(obj(a)['state']) });
  for (const [id, v] of Object.entries(obj(s['stats']))) {
    const x = statOf(v);
    w.upsert(e.stat, { id, a: x.a, b: x.b, n: Math.round(x.n), usd: x.usd, usd_n: Math.round(x.usdN), ms: x.ms, at: x.at });
  }
  for (const [id, v] of Object.entries(obj(s['routes']))) {
    const r = routeOf(v);
    w.upsert(e.route, { id, key: r.key, type: r.type, r: r.r, at: r.at, data: r });
  }
  for (const [id, v] of Object.entries(obj(s['taste']))) {
    const t = tasteOf(v);
    w.upsert(e.taste, { id, n: t.n, at: t.at, raw: t.raw });
  }
  const pairs = Array.isArray(s['pairs']) ? s['pairs'].map(obj) : [];
  // the file is the whole list: a re-import replaces what an earlier one appended
  for (const old of store.query(e.pair, { select: ['id'] })) if (old.id !== undefined) w.del(e.pair, old.id);
  if (pairs.length) w.append(e.pair, pairs.map((p): PairRow => ({ type: String(p['type'] ?? ''), auto: String(p['auto'] ?? ''), chose: String(p['chose'] ?? ''), at: num(p['at']) })));
  for (const [target, v] of Object.entries(obj(s['cooling']))) w.upsert(e.cool, { target, until: num(obj(v)['until']), why: String(obj(v)['why'] ?? '') });
  if (typeof s['backfilled'] === 'number') w.upsert(e.meta, { key: 'backfilled', value: String(s['backfilled']) });
}
