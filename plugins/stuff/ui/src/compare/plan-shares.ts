// Plan cells, in createdAt order, and the line with what overlapping runs took together. wisp splits
// a window's move among the turns running on the account by time (v1 server/budget.js #sharers), so
// runs that overlap on one account can't each show a true share: only their total is known. Pooled
// is read from the turns, not from turn.plan: a share lands late, and a turn that has none yet was
// still running beside the others.

import { byAge, letter, listed, own, workOf, type T } from './metrics.ts';
import { longestFirst, pct, windowKey } from './receipt.ts';
import type { Run, RunTurn } from './types.ts';

export const DASH = '—';

interface Span {
  readonly t: RunTurn;
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly cost: number | null;
  pooled: boolean;
}
interface RunSpans {
  readonly i: number;
  readonly turns: Span[];
  readonly solo: Record<string, number>;
}
interface Pool {
  readonly key: string;
  readonly window: string;
  used: number;
  readonly members: Map<RunSpans, Span[]>;
  split: boolean;
  costs: number;
  waiting: boolean;
}

export interface PlanCell {
  readonly text: string;
  readonly tip: string;
}

const accountKey = (agent: string | undefined, account: string | undefined): string => `${agent ?? ''}@${account || 'default'}`;
const windowWords = (t: T, id: string): string => {
  const w = windowKey(id);
  return t(w.key, w.vars);
};

function spansOf(sessions: readonly Run[], now: number): RunSpans[] {
  const runs = byAge(sessions).map((s, i) => {
    const work = workOf(s);
    const turns = own(s)
      .filter((t) => Number.isFinite(t.startedAt))
      .map((t): Span => ({ t, key: accountKey(t.agent || s.agent, t.account || s.account), from: t.startedAt ?? 0, to: t.endedAt ?? now, cost: work.get(t)?.cost ?? null, pooled: false }));
    return { i, turns, solo: {} };
  });
  const overlap = (a: Span, b: Span): boolean => a.key === b.key && a.from < b.to && b.from < a.to;
  for (const r of runs) for (const x of r.turns) x.pooled = runs.some((o) => o !== r && o.turns.some((y) => overlap(x, y)));
  return runs;
}

function poolsOf(runs: readonly RunSpans[]): Map<string, Pool> {
  const pools = new Map<string, Pool>(); // "agent@account window"
  for (const r of runs) {
    for (const x of r.turns) {
      for (const p of x.t.plan ?? []) {
        if (!p.window || !(p.used > 0)) continue;
        if (!x.pooled) {
          r.solo[p.window] = (r.solo[p.window] ?? 0) + p.used;
          continue;
        }
        const key = accountKey(p.agent, p.account);
        const id = `${key} ${p.window}`;
        const pool = pools.get(id) ?? { key, window: p.window, used: 0, members: new Map(), split: false, costs: 0, waiting: false };
        pool.used += p.used;
        pools.set(id, pool);
      }
    }
  }
  return pools;
}

function sharedPools(runs: readonly RunSpans[]): Pool[] {
  const shared: Pool[] = [];
  for (const pool of poolsOf(runs).values()) {
    for (const r of runs) {
      const mine = r.turns.filter((x) => x.pooled && (x.key === pool.key || (x.t.plan ?? []).some((p) => p.window === pool.window && accountKey(p.agent, p.account) === pool.key)));
      if (mine.length) pool.members.set(r, mine);
    }
    // One turn's entry on an account the others never touched: nothing to split.
    if (pool.members.size < 2) {
      for (const r of pool.members.keys()) r.solo[pool.window] = (r.solo[pool.window] ?? 0) + pool.used;
      continue;
    }
    const turns = [...pool.members.values()].flat();
    pool.costs = turns.reduce((a, x) => a + (x.cost ?? 0), 0);
    pool.split = pool.costs > 0 && turns.every((x) => x.cost !== null);
    pool.waiting = turns.some((x) => x.cost === null && x.t.status === 'running'); // its cost is on the way
    shared.push(pool);
  }
  return shared;
}

function cellOf(t: T, r: RunSpans, shared: readonly Pool[]): PlanCell {
  const mine = shared.filter((p) => p.members.has(r));
  const window = [...new Set([...Object.keys(r.solo), ...mine.map((p) => p.window)])].map((w) => ({ window: w })).sort(longestFirst)[0]?.window;
  if (!window) return { text: DASH, tip: '' };
  const name = windowWords(t, window);
  const here = mine.filter((p) => p.window === window);
  const solo = r.solo[window] ?? 0;
  if (!here.length) return { text: t('stuff.compare.plan.cell', { pct: pct(solo), window: name }), tip: '' };
  const stuck = here.find((p) => !p.split);
  if (stuck) return { text: DASH, tip: stuck.waiting ? '' : t('stuff.compare.plan.noCost') };
  const part = here.reduce((a, p) => a + (p.used * (p.members.get(r) ?? []).reduce((c, x) => c + (x.cost ?? 0), 0)) / p.costs, 0);
  return { text: t('stuff.compare.plan.estimate', { pct: pct(solo + part), window: name }), tip: t('stuff.compare.plan.estimateTip') };
}

function totalOf(t: T, runs: readonly RunSpans[], shared: readonly Pool[]): string {
  // One line per account, on its longest window, as on a cell.
  const longest = new Map<string, Pool>();
  for (const p of [...shared].sort(longestFirst)) if (!longest.has(p.key)) longest.set(p.key, p);
  const who = (p: Pool): string => {
    const size = p.members.size;
    if (size < runs.length) return listed(t, [...p.members.keys()].map((r) => letter(r.i)).sort());
    return size === 2 ? t('stuff.compare.bothRuns') : t('stuff.compare.allRuns', { n: size });
  };
  return [...longest.values()].map((p) => t('stuff.compare.plan.total', { who: who(p), pct: pct(p.used), window: windowWords(t, p.window) })).join(' ');
}

export function planShares(t: T, sessions: readonly Run[], now = Date.now()): { cells: PlanCell[]; total: string } {
  const runs = spansOf(sessions, now);
  const shared = sharedPools(runs);
  return { cells: runs.map((r) => cellOf(t, r, shared)), total: totalOf(t, runs, shared) };
}
