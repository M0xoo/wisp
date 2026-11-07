// Try it two ways: each run's plan share (v1 web/js/compare-metrics.js planShares). wisp splits a
// window's move among the turns running on the account by time (host #sharers), so runs that
// overlap on one account can't each show a true share: only their total is known. Pooled is read
// from the turns, not from their shares: a share lands late, and a turn that has none yet was still
// running beside the others.

import { longestFirst, pct, windowName } from './receipt.ts';
import { byAge, letter, listed, own, turnPlan, workOf } from './work.ts';
import type { RunLike, TurnLike } from './work.ts';

const ESTIMATE = "An estimate. When runs overlap on one account, wisp can only trace what they took together, so this splits the total by each run's cost.";
const NO_COST = "Not every run reported a cost, so wisp can't split the total between them.";
const DASH = '—';

interface Span {
  t: TurnLike;
  key: string;
  from: number;
  to: number;
  cost: number | null;
  pooled: boolean;
}
interface Run {
  i: number;
  turns: Span[];
  solo: Record<string, number>;
}
interface Pool {
  key: string;
  window: string;
  used: number;
  members: Map<Run, Span[]>;
  split?: boolean;
  costs?: number;
  waiting?: boolean;
}

function runsOf(sessions: readonly RunLike[], now: number): Run[] {
  const runs = byAge(sessions).map((s, i): Run => {
    const work = workOf(s);
    const turns = own(s)
      .filter((t) => Number.isFinite(t.startedAt))
      .map((t): Span => ({ t, key: `${t.agent || s.agent}@${t.account || s.account || 'default'}`, from: t.startedAt ?? 0, to: t.endedAt ?? now, cost: work.get(t)?.cost ?? null, pooled: false }));
    return { i, turns, solo: {} };
  });
  const overlap = (a: Span, b: Span): boolean => a.key === b.key && a.from < b.to && b.from < a.to;
  for (const r of runs) for (const x of r.turns) x.pooled = runs.some((o) => o !== r && o.turns.some((y) => overlap(x, y)));
  return runs;
}

function poolsOf(runs: Run[]): Pool[] {
  const pools = new Map<string, Pool>(); // "agent@account window"
  for (const r of runs) {
    for (const x of r.turns) {
      for (const p of turnPlan(x.t)) {
        if (!p.window || !(p.used > 0)) continue;
        if (!x.pooled) {
          r.solo[p.window] = (r.solo[p.window] ?? 0) + p.used;
          continue;
        }
        const key = `${p.agent}@${p.account || 'default'}`;
        const id = `${key} ${p.window}`;
        const pool = pools.get(id) ?? { key, window: p.window, used: 0, members: new Map() };
        pools.set(id, pool);
        pool.used += p.used;
      }
    }
  }
  const shared: Pool[] = [];
  for (const pool of pools.values()) {
    for (const r of runs) {
      const mine = r.turns.filter((x) => x.pooled && (x.key === pool.key || turnPlan(x.t).some((p) => p.window === pool.window && `${p.agent}@${p.account || 'default'}` === pool.key)));
      if (mine.length) pool.members.set(r, mine);
    }
    // One turn's entry on an account the others never touched: nothing to split.
    if (pool.members.size < 2) {
      for (const r of pool.members.keys()) r.solo[pool.window] = (r.solo[pool.window] ?? 0) + pool.used;
      continue;
    }
    const turns = [...pool.members.values()].flat();
    const costs = turns.reduce((a, x) => a + (x.cost ?? 0), 0);
    pool.split = costs > 0 && turns.every((x) => x.cost !== null);
    pool.costs = costs;
    pool.waiting = turns.some((x) => x.cost === null && x.t.status === 'running'); // its cost is on the way
    shared.push(pool);
  }
  return shared;
}

function cellOf(r: Run, shared: Pool[]): { text: string; tip: string } {
  const mine = shared.filter((p) => p.members.has(r));
  const window = [...new Set([...Object.keys(r.solo), ...mine.map((p) => p.window)])].map((w) => ({ window: w })).sort(longestFirst)[0]?.window;
  if (!window) return { text: DASH, tip: '' };
  const name = windowName(window);
  const here = mine.filter((p) => p.window === window);
  const solo = r.solo[window] ?? 0;
  if (!here.length) return { text: `${pct(solo)} of ${name}`, tip: '' };
  const stuck = here.find((p) => !p.split);
  if (stuck) return { text: DASH, tip: stuck.waiting ? '' : NO_COST };
  const part = here.reduce((a, p) => a + (p.used * (p.members.get(r) ?? []).reduce((c, x) => c + (x.cost ?? 0), 0)) / (p.costs || 1), 0);
  return { text: `≈${pct(solo + part)} of ${name}`, tip: ESTIMATE };
}

/** Plan cells, in createdAt order, and the line with what overlapping runs took together. */
export function planShares(sessions: readonly RunLike[], now: number): { cells: { text: string; tip: string }[]; total: string } {
  const runs = runsOf(sessions, now);
  const shared = poolsOf(runs);
  const cells = runs.map((r) => cellOf(r, shared));
  // One line per account, on its longest window, as on a cell.
  const longest = new Map<string, Pool>();
  for (const p of [...shared].sort(longestFirst)) if (!longest.has(p.key)) longest.set(p.key, p);
  const who = (p: Pool): string => {
    const k = p.members.size;
    if (k < runs.length) return listed([...p.members.keys()].map((r) => letter(r.i)).sort());
    return k === 2 ? 'Both runs' : `All ${k} runs`;
  };
  return { cells, total: [...longest.values()].map((p) => `${who(p)} took ${pct(p.used)} of ${windowName(p.window)}.`).join(' ') };
}
