// What the router knows, in memory (v1 kept it in ~/.wisp/router.json; v2 keeps it in router_* rows,
// rows.ts). Picks read only this, so a decision never touches the database; every change marks what
// it touched, and rows.ts writes exactly those rows in one transaction.

import type { StoredRoute } from '@wisp-plugin/router-api';
import { canon } from './keys.ts';

/** Outcomes of one arm on one kind of task ('*' is every kind): a Beta(a, b) and what runs cost. */
export interface Stat {
  a: number;
  b: number;
  n: number;
  usd: number;
  usdN: number;
  ms: number;
  at: number;
}

export interface ArmState {
  firstSeen: number;
  /** 'new': on probation until it has shown what it can do; 'gone': uninstalled, kept for its record */
  state: 'ready' | 'new' | 'gone';
}

/** Your picks of one run on one kind of task, decayed, and the names you launched it by. */
export interface Taste {
  n: number;
  at: number;
  raw: Record<string, number>;
}

/** A preview you changed before sending: Auto's pick and yours. */
export interface Pair {
  id?: number;
  type: string;
  auto: string;
  chose: string;
  at: number;
}

export interface Cool {
  until: number;
  why: string;
}

export const splitStat = (sk: string): { type: string; key: string } => {
  const i = sk.indexOf('|');
  return { type: sk.slice(0, i), key: sk.slice(i + 1) };
};

type Table = 'arms' | 'stats' | 'routes' | 'taste' | 'cooling';

export class RouterState {
  readonly arms = new Map<string, ArmState>();
  /** `${type}|${key}` → stat, the key as the run was recorded (canon() groups them) */
  readonly stats = new Map<string, Stat>();
  /** type → canon(key) → `${type}|${key}` → stat: what an estimate reads, without a scan of every row */
  readonly #byType = new Map<string, Map<string, Map<string, Stat>>>();
  /** session id → route, oldest first */
  readonly routes = new Map<string, StoredRoute>();
  /** `${type}|${canon}` → taste */
  readonly taste = new Map<string, Taste>();
  readonly #tasteByType = new Map<string, Map<string, Taste>>();
  pairs: Pair[] = [];
  readonly cooling = new Map<string, Cool>();
  backfilled: number | null = null;

  /** what changed since the last write: keys to upsert or delete, pairs to append or drop */
  readonly dirty = { arms: new Set<string>(), stats: new Set<string>(), routes: new Set<string>(), taste: new Set<string>(), cooling: new Set<string>(), pairs: [] as Pair[], dropPairs: [] as number[], meta: false };

  touch(table: Table, key: string): void {
    this.dirty[table].add(key);
  }

  setStat(sk: string, s: Stat): void {
    this.stats.set(sk, s);
    const { type, key } = splitStat(sk);
    const byCanon = this.#byType.get(type) ?? new Map<string, Map<string, Stat>>();
    this.#byType.set(type, byCanon);
    const c = canon(key);
    const list = byCanon.get(c) ?? new Map<string, Stat>();
    byCanon.set(c, list);
    list.set(sk, s);
  }

  /** the stat of (type, key), made empty when there's none yet; marked changed */
  statOf(type: string, key: string, now: number): Stat {
    const sk = `${type}|${key}`;
    let s = this.stats.get(sk);
    if (!s) {
      s = { a: 0, b: 0, n: 0, usd: 0, usdN: 0, ms: 0, at: now };
      this.setStat(sk, s);
    }
    this.touch('stats', sk);
    return s;
  }

  /** every recorded name of one run on one kind of task */
  statsOf(type: string, c: string): ReadonlyMap<string, Stat> | undefined {
    return this.#byType.get(type)?.get(c);
  }

  /** canon keys with a record on a kind of task */
  canonsOf(type: string): Iterable<string> {
    return this.#byType.get(type)?.keys() ?? [];
  }

  setTaste(k: string, t: Taste): void {
    this.taste.set(k, t);
    const { type, key } = splitStat(k);
    const m = this.#tasteByType.get(type) ?? new Map<string, Taste>();
    this.#tasteByType.set(type, m);
    m.set(key, t);
  }

  tasteOf(type: string): ReadonlyMap<string, Taste> {
    return this.#tasteByType.get(type) ?? new Map();
  }

  /** forget outcomes and picks (Reset): every row of them goes */
  clearLearned(): void {
    for (const k of this.stats.keys()) this.touch('stats', k);
    for (const k of this.routes.keys()) this.touch('routes', k);
    for (const k of this.taste.keys()) this.touch('taste', k);
    for (const p of this.pairs) if (p.id !== undefined) this.dirty.dropPairs.push(p.id);
    this.stats.clear();
    this.#byType.clear();
    this.routes.clear();
    this.taste.clear();
    this.#tasteByType.clear();
    this.pairs = [];
    this.dirty.pairs = [];
  }
}
