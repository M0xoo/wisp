// What a turn read and wrote, and how a share of a plan window reads (v1 web/js/receipt.js, the
// parts Compare uses). Anthropic counts cache reads and writes apart from input_tokens; OpenAI's
// input_tokens already holds the cached ones. Pure: the tests read it as is.

import type { RunTurn } from './types.ts';

export interface Tokens {
  readonly read: number;
  readonly cached: number;
  readonly output: number;
}

const DAY = 864e5;
// The longest window first: with the 5-hour one gone on some plans, the week is what people count.
const LENGTH: Readonly<Record<string, number>> = { seven_day: 7 * DAY, seven_day_opus: 7 * DAY - 1, seven_day_sonnet: 7 * DAY - 2, five_hour: 5 * 36e5 };
const minutesOf = (id: string): number => Number(/^w(\d+)m$/.exec(id)?.[1]) || 0;
const lengthOf = (id: string): number => LENGTH[id] ?? minutesOf(id) * 60_000;

export const longestFirst = (a: { readonly window: string }, b: { readonly window: string }): number => lengthOf(b.window) - lengthOf(a.window);

/** A window's name for a sentence, as a key and its vars: "weekly", "3-day". */
export function windowKey(id: string): { key: string; vars?: Readonly<Record<string, number>> } {
  const named: Readonly<Record<string, string>> = { five_hour: 'fiveHour', seven_day: 'weekly', seven_day_opus: 'weeklyOpus', seven_day_sonnet: 'weeklySonnet' };
  const name = named[id];
  if (name) return { key: `stuff.compare.window.${name}` };
  const mins = minutesOf(id);
  if (!mins) return { key: 'stuff.compare.window.plan' };
  return mins >= 1440 ? { key: 'stuff.compare.window.days', vars: { n: Math.round(mins / 1440) } } : { key: 'stuff.compare.window.hours', vars: { n: Math.round(mins / 60) } };
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

// Before stats.totals, a resumed turn's models held the whole conversation so far, so an older
// turn is read from usage alone.
const modelsIn = (t: RunTurn): NonNullable<NonNullable<RunTurn['stats']>['models']> => (t.stats?.totals && t.stats.models) || [];

/** What a turn read (its cache reads and writes counted in), of that from the cache, and wrote. */
export function turnTokens(t: RunTurn | undefined): Tokens {
  const st = t?.stats ?? {};
  const anthropic = 'cacheReadTokens' in st || 'cacheWriteTokens' in st;
  const read = anthropic ? n(st.inputTokens) + n(st.cacheReadTokens) + n(st.cacheWriteTokens) : n(st.inputTokens);
  const cached = anthropic ? n(st.cacheReadTokens) : Math.min(n(st.cachedInputTokens), read);
  // Claude's modelUsage counts every model the run used, its subagents' included, which usage can
  // leave out: the larger of the two is the turn's.
  const models = t ? modelsIn(t) : [];
  if (models.length) {
    const m = models.reduce<Tokens>((a, x) => ({ read: a.read + n(x.input) + n(x.cacheRead) + n(x.cacheWrite), cached: a.cached + n(x.cacheRead), output: a.output + n(x.output) }), { read: 0, cached: 0, output: 0 });
    if (m.read + m.output > read + n(st.outputTokens)) return m;
  }
  return { read, cached, output: n(st.outputTokens) };
}

/** 38400 → "38k", 1250000 → "1.3M", 820 → "820". */
export function tokenWords(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (x >= 1e3) return `${Math.round(x / 1e3)}k`;
  return String(Math.round(x));
}

/** "<1%" for a share too small to round to one, and never "100%" for one that isn't all of it. */
export const pct = (x: number): string => (x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.99 ? '99%' : `${Math.round(x * 100)}%`);
