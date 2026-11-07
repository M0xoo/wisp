// A run's own work, turn by turn (v1 web/js/compare-metrics.js workOf): the stored counters aren't
// always each turn's. Claude's costUsd before stats.totals and Codex's tokens without stats.totals
// are the conversation's running total, so a turn is the difference with the one before it. A copied
// turn (a fork's first turns, a shared task's) ran elsewhere: it moves the counters, but isn't counted.

import { turnTokens } from './receipt.ts';
import type { StatsLike } from './receipt.ts';

/** A turn's part of a window's move (v1 turn.plan; v2 `turn.ext['wisp.budget'].plan`). */
export interface Share {
  agent: string;
  account: string;
  window: string;
  used: number;
  resetsAt: number | null;
}

/** A turn as stored (v1 field names), for the pure readers here. Everything is optional. */
export interface TurnLike {
  id?: string | undefined;
  agent?: string | undefined;
  account?: string | undefined;
  model?: string | undefined;
  status?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | null | undefined;
  stats?: StatsLike | null | undefined;
  by?: string | undefined;
  forked?: boolean | undefined;
  shared?: boolean | undefined;
  plan?: Share[] | undefined;
  activity?: { kind: string }[] | undefined;
  trimmed?: number | undefined;
  changes?: { edits?: { before: string; after: string }[] | undefined }[] | undefined;
  presentation?: { blocks?: { type?: string; passed?: unknown; failed?: unknown }[] } | null | undefined;
  details?: { tools?: { hash?: string; list?: string[] } | undefined } | undefined;
  ext?: Record<string, unknown> | undefined;
}

export interface RunLike {
  id?: string | undefined;
  title?: string | undefined;
  agent?: string | undefined;
  account?: string | undefined;
  state?: string | undefined;
  parentId?: string | undefined;
  createdAt?: number | undefined;
  turns?: TurnLike[] | undefined;
}

const isShare = (v: unknown): v is Share => !!v && typeof v === 'object' && typeof (v as Share).window === 'string' && typeof (v as Share).used === 'number';

/** A turn's shares: v1's `turn.plan`, or what wisp.budget keeps in the turn's ext slot. */
export function turnPlan(t: TurnLike): Share[] {
  if (t.plan) return t.plan;
  const mine = t.ext?.['wisp.budget'];
  const plan = mine && typeof mine === 'object' ? (mine as { plan?: unknown }).plan : undefined;
  return Array.isArray(plan) ? plan.filter(isShare) : [];
}

export const copied = (t: TurnLike): boolean => !!(t.forked || t.shared);
export const own = (s: RunLike | undefined): TurnLike[] => (s?.turns ?? []).filter((t) => !copied(t));
export const tidy = (x: number): number => Math.round(x * 1e7) / 1e7; // differences of totals leave float dust
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export interface Tokens {
  read: number;
  cached: number;
  output: number;
}

/** A Claude turn's own cost, or null. counter: what it stood at after the turn before. */
function ownCost(agent: string, st: StatsLike, counter: Map<string, number>): number | null {
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

function ownTokens(agent: string, t: TurnLike, counter: Map<string, Tokens>): Tokens {
  const tokens = turnTokens(t);
  if (agent !== 'codex') return tokens;
  if (t.stats?.totals) {
    counter.set(agent, turnTokens({ stats: t.stats.totals }));
    return tokens;
  }
  if (!tokens.read && !tokens.output) return tokens; // never got to report: the counter stands
  const was = counter.get(agent) ?? { read: 0, cached: 0, output: 0 };
  counter.set(agent, tokens);
  if (tokens.read < was.read || tokens.output < was.output) return tokens;
  return { read: tokens.read - was.read, cached: Math.max(0, tokens.cached - was.cached), output: tokens.output - was.output };
}

/** Each turn's own work. A copy or a baseline moves the counters, so the turn after differences correctly, but isn't in it. */
export function workOf(session: RunLike | undefined): Map<TurnLike, { cost: number | null; tokens: Tokens }> {
  const out = new Map<TurnLike, { cost: number | null; tokens: Tokens }>();
  const costs = new Map<string, number>();
  const tokens = new Map<string, Tokens>();
  for (const t of session?.turns ?? []) {
    const agent = t.agent || session?.agent || '';
    const st = t.stats ?? {};
    const work = { cost: ownCost(agent, st, costs), tokens: ownTokens(agent, t, tokens) };
    if (!copied(t) && !st.baseline) out.set(t, work);
  }
  return out;
}

export const byAge = <T extends { createdAt?: number | undefined }>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
export const letter = (i: number): string => String.fromCharCode(65 + i);
export const listed = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1) ?? ''}` : (xs[0] ?? ''));
