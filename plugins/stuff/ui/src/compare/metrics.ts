// Compare's numbers (v1 web/js/compare-metrics.js): what each run of a task took over all its
// turns. A run is compared on its own work: a copied turn (a fork's first turns, a shared task's)
// ran elsewhere. The stored counters aren't always each turn's (v1 server/allowance.js readingOf):
// Claude's costUsd before stats.totals and Codex's tokens without stats.totals are the
// conversation's running total, so such a turn is the difference with the one before it.

import { countChanges } from './line-count.ts';
import { longestFirst, turnTokens, type Tokens } from './receipt.ts';
import type { Metrics, Run, RunTurn } from './types.ts';

/** The i18n lookup these pure functions word their output with (PluginClient.t, or a test's). */
export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

const STEP_KINDS = new Set(['run', 'tool', 'read', 'edit', 'agent', 'web', 'search']);

export const copied = (t: RunTurn): boolean => !!(t.forked || t.shared);
export const own = (s: Run | undefined): readonly RunTurn[] => (s?.turns ?? []).filter((t) => !copied(t));
/** differences of totals leave float dust */
export const tidy = (x: number): number => Math.round(x * 1e7) / 1e7;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export const byAge = <R extends { readonly createdAt?: number }>(list: readonly R[]): R[] => [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
export const isLive = (s: { readonly state?: string } | undefined): boolean => s?.state === 'running' || s?.state === 'waiting';
export const letter = (i: number): string => String.fromCharCode(65 + i);

/** "A", "A and B", "A, B and C". */
export function listed(t: T, xs: readonly string[]): string {
  if (xs.length < 2) return xs[0] ?? '';
  return t('stuff.compare.list', { rest: xs.slice(0, -1).join(', '), last: xs[xs.length - 1] ?? '' });
}

/** A Claude turn's own cost, or null. counter: what it stood at after the turn before. */
function ownCost(agent: string, t: RunTurn, counter: Map<string, number>): number | null {
  const st = t.stats ?? {};
  if (agent !== 'claude') return num(st.costUsd);
  if (st.totals) {
    const total = st.totals.costUsd;
    if (typeof total === 'number' && Number.isFinite(total)) counter.set(agent, total);
    return num(st.costUsd);
  }
  const now = num(st.costUsd);
  if (now === null) return null;
  const was = counter.get(agent) ?? 0;
  counter.set(agent, now);
  return tidy(now >= was ? now - was : now); // less than before: the counters started over
}

function ownTokens(agent: string, t: RunTurn, counter: Map<string, Tokens>): Tokens {
  const tokens = turnTokens(t);
  if (agent !== 'codex') return tokens;
  if (t.stats?.totals) {
    counter.set(agent, turnTokens({ id: '', status: 'done', stats: t.stats.totals }));
    return tokens;
  }
  if (!tokens.read && !tokens.output) return tokens; // never got to report: the counter stands
  const was = counter.get(agent) ?? { read: 0, cached: 0, output: 0 };
  counter.set(agent, tokens);
  if (tokens.read < was.read || tokens.output < was.output) return tokens;
  return { read: tokens.read - was.read, cached: Math.max(0, tokens.cached - was.cached), output: tokens.output - was.output };
}

export interface Work {
  readonly cost: number | null;
  readonly tokens: Tokens;
}

/** Each turn's own work. A copy or a baseline moves the counters, so the turn after differences
 *  correctly, but isn't in it. */
export function workOf(session: Run | undefined): Map<RunTurn, Work> {
  const out = new Map<RunTurn, Work>();
  const costs = new Map<string, number>();
  const tokens = new Map<string, Tokens>();
  for (const t of session?.turns ?? []) {
    const agent = t.agent || session?.agent || '';
    const work = { cost: ownCost(agent, t, costs), tokens: ownTokens(agent, t, tokens) };
    if (!copied(t) && !t.stats?.baseline) out.set(t, work);
  }
  return out;
}

function testsOf(t: RunTurn | undefined): Metrics['tests'] {
  const tests = (t?.presentation?.blocks ?? []).filter((b): b is { type: 'tests'; passed?: unknown; failed?: unknown } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tests');
  if (!tests.length) return null;
  return { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) };
}

function timeOf(t: RunTurn): number | null {
  if (t.status === 'running') return null;
  const ms = t.stats?.durationMs;
  if (typeof ms === 'number' && ms > 0) return ms;
  return t.endedAt && t.startedAt !== undefined ? t.endedAt - t.startedAt : null;
}

interface Totals {
  time: number | null;
  cost: number | null;
  read: number;
  cached: number;
  output: number;
  steps: number | null;
  missing: boolean;
  plan: Record<string, number>;
}

function totalsOf(turns: readonly RunTurn[], work: Map<RunTurn, Work>): Totals {
  const o: Totals = { time: null, cost: null, read: 0, cached: 0, output: 0, steps: null, missing: false, plan: {} };
  for (const t of turns) {
    const ms = timeOf(t);
    if (ms !== null) o.time = (o.time ?? 0) + ms;
    const w = work.get(t);
    if (w?.cost != null) o.cost = tidy((o.cost ?? 0) + w.cost);
    else if (w && t.status !== 'running' && t.endedAt) o.missing = true;
    o.read += w?.tokens.read ?? 0;
    o.cached += w?.tokens.cached ?? 0;
    o.output += w?.tokens.output ?? 0;
    o.steps = (o.steps ?? 0) + (t.activity ?? []).filter((a) => STEP_KINDS.has(a.kind)).length + (t.trimmed ?? 0);
    for (const p of t.plan ?? []) if (p.window && p.used > 0) o.plan[p.window] = (o.plan[p.window] ?? 0) + p.used;
  }
  return o;
}

/** One run's numbers. time, cost, tokens and steps are totals over its turns; files, add, del,
 *  tests and asks are what its last turn left, as the turn itself shows them. */
export function runMetrics(session: Run): Metrics {
  const turns = own(session);
  const o = totalsOf(turns, workOf(session));
  const last = turns[turns.length - 1];
  const lines = (last?.changes ?? []).reduce((acc, c) => {
    const x = countChanges(c.edits);
    return { add: acc.add + x.add, del: acc.del + x.del };
  }, { add: 0, del: 0 });
  const live = isLive(session);
  return {
    id: session.id,
    agent: session.agent,
    createdAt: session.createdAt,
    live,
    time: o.time,
    cost: o.cost,
    costPartial: o.cost !== null && o.missing,
    tokens: o.read + o.output || null,
    // As on the receipt: a harness that doesn't report cached tokens has no cache number, not 0%.
    cache: o.read && o.cached ? o.cached / o.read : null,
    steps: o.steps,
    plan: Object.entries(o.plan).map(([window, used]) => ({ window, used })).sort(longestFirst),
    files: last?.changes?.length ?? 0,
    ...lines,
    tests: testsOf(last),
    asks: (last?.activity ?? []).filter((a) => a.kind === 'ask').length,
    // yours, as in the task's summary: a Compact or Auto's repair turn isn't one
    followUps: turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length,
    unfinished: !live && (last?.status === 'error' || last?.status === 'stopped'),
  };
}
