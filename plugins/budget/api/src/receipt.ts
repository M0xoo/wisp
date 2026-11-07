// The pieces of a turn's usage receipt budget reads (v1 web/js/receipt.js): what a turn read and
// wrote, its subagents' output, window names and the median. DOM-free, shared by the page and server.

const DAY = 864e5;
const NAMES: Readonly<Record<string, string>> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
// The longest window first: with the 5-hour one gone on some plans, the week is what people count.
const LENGTH: Readonly<Record<string, number>> = { seven_day: 7 * DAY, seven_day_opus: 7 * DAY - 1, seven_day_sonnet: 7 * DAY - 2, five_hour: 5 * 36e5 };
const lengthOf = (id: string): number => LENGTH[id] ?? (Number(/^w(\d+)m$/.exec(id)?.[1]) * 60_000 || 0);
export const longestFirst = (a: { window: string }, b: { window: string }): number => lengthOf(b.window) - lengthOf(a.window);

export function windowName(id: string): string {
  const named = NAMES[id];
  if (named) return named;
  const mins = Number(/^w(\d+)m$/.exec(id)?.[1]) || 0;
  return !mins ? 'plan' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
}

/** A subagent's line in stats.subagents (v1 adapters/claude.js subagentTally). */
export interface SubagentStat {
  type: string;
  calls?: number;
  model?: string;
  read?: number;
  output?: number;
  same?: boolean;
  instead?: string;
}
export interface ModelStat {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
/** A turn's stats as harnesses store them (v1 field names; every field optional). */
export interface StatsLike {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cachedInputTokens?: number;
  durationMs?: number;
  /** the CLI's own turn count inside the run */
  turns?: number;
  baseline?: boolean;
  totals?: StatsLike & { thread?: string };
  models?: ModelStat[] | Record<string, unknown>;
  subagents?: SubagentStat[];
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
// stats.models of a turn. Before stats.totals, a resumed turn's models held the whole conversation
// so far, so an older turn is read from usage alone.
const modelsIn = (st: StatsLike | null | undefined): ModelStat[] => (st?.totals && Array.isArray(st.models) ? st.models : []);
/** A subagent's output: without stats.totals it came from those models, so it can be the conversation's. */
export const subagentOutput = (st: StatsLike | null | undefined, x: SubagentStat | undefined): number => (st?.totals && n(x?.output) ? n(x?.output) : 0);

/** What a turn read (its cache reads and writes counted in), of that from the cache, and wrote. */
export function turnTokens(t: { stats?: StatsLike | null | undefined } | null | undefined): { read: number; cached: number; output: number } {
  const st = t?.stats ?? {};
  const anthropic = 'cacheReadTokens' in st || 'cacheWriteTokens' in st;
  const read = anthropic ? n(st.inputTokens) + n(st.cacheReadTokens) + n(st.cacheWriteTokens) : n(st.inputTokens);
  const cached = anthropic ? n(st.cacheReadTokens) : Math.min(n(st.cachedInputTokens), read);
  // Claude's modelUsage counts every model the run used, its subagents' included, which usage can
  // leave out: the larger of the two is the turn's.
  const models = modelsIn(st);
  if (models.length) {
    const m = models.reduce<{ read: number; cached: number; output: number }>((a, x) => ({ read: a.read + n(x.input) + n(x.cacheRead) + n(x.cacheWrite), cached: a.cached + n(x.cacheRead), output: a.output + n(x.output) }), { read: 0, cached: 0, output: 0 });
    if (m.read + m.output > read + n(st.outputTokens)) return m;
  }
  return { read, cached, output: n(st.outputTokens) };
}

/** All the output the turn wrote, its subagents' included. */
export function turnOutput(t: { stats?: StatsLike | null | undefined } | null | undefined): number {
  const st = t?.stats ?? {};
  const models = modelsIn(st).reduce((a, m) => a + n(m.output), 0);
  const subs = (st.subagents ?? []).reduce((a, x) => a + subagentOutput(st, x), 0);
  return Math.max(models, n(st.outputTokens) + subs);
}

/** 38400 → "38k", 1250000 → "1.3M", 820 → "820". */
export function tokenWords(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (x >= 1e3) return `${Math.round(x / 1e3)}k`;
  return String(Math.round(x));
}

/** "<1%" for a share too small to round to one, and never "100%" for one that isn't all of it. */
export const pct = (x: number): string => (x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.99 ? '99%' : `${Math.round(x * 100)}%`);

/** Account comparison: each account's median turn over the last 7 days, once each has 5 on a model. */
export const COMPARE_MIN = 5;
export const COMPARE_DAYS = 7;

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] ?? 0) : ((a[m - 1] ?? 0) + (a[m] ?? 0)) / 2;
}
