// A task's usage, for its details column (v1 #785, TRY-16; web/js/task-usage.js): the line with its share of the plan,
// its wisp subagents' in (with none traced, its tokens), the line with how full its context is, and the card either
// opens. The server sums the task with its subagents (wisp-runtime host usage_row.rs: the row's `usage`, `subUsage`,
// `context`); the card's token split is read from the open task's turns. DOM-free.
import type { TaskUsageProps, TaskUsageRow, TaskUsageSection } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { windowName } from './compare.ts';

type T = ShellContext['t'];
type Plan = Readonly<Record<string, number>>;

export interface Context {
  readonly tokens: number;
  readonly window: number;
}
export interface SubUsage {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly agent: string;
  readonly tokens: number;
  readonly plan?: Plan;
  /** false: its share is of another plan's windows (another harness or account): the lead's line leaves it out */
  readonly samePlan?: boolean;
}
/** The row's usage fields (all optional: nothing measured, nothing said). */
export interface RowUsage {
  readonly tokens?: number;
  readonly context?: Context;
  readonly plan?: Plan;
  readonly usage?: { readonly tokens: number; readonly plan?: Plan };
  readonly subUsage?: readonly SubUsage[];
}
/** What the card reads of a turn's stats (runtime's TurnStats). */
export interface TurnStatsLike {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheTokens?: number;
  readonly models?: Readonly<Record<string, { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number }>>;
}

const n0 = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
const planOf = (x: unknown): Plan | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, v]) => n0(v) > 0)) : undefined);

/** The row's fields, checked: a stale or foreign shape reads as nothing. */
export function rowUsage(f: Readonly<Record<string, unknown>>): RowUsage {
  const c = f['context'] as Partial<Context> | undefined;
  const u = f['usage'] as { tokens?: unknown; plan?: unknown } | undefined;
  const subs = Array.isArray(f['subUsage']) ? (f['subUsage'] as readonly SubUsage[]).filter((s) => typeof s?.id === 'string') : [];
  const plan = planOf(f['plan']);
  const total = u && typeof u === 'object' ? { tokens: n0(u.tokens), ...(planOf(u.plan) && { plan: planOf(u.plan) as Plan }) } : undefined;
  return {
    ...(n0(f['tokens']) && { tokens: n0(f['tokens']) }),
    ...(c && typeof c === 'object' && typeof c.tokens === 'number' && { context: { tokens: n0(c.tokens), window: n0(c.window) } }),
    ...(plan && { plan }),
    ...(total && { usage: total }),
    ...(subs.length > 0 && { subUsage: subs }),
  };
}

const DAY = 864e5;
const LENGTH: Readonly<Record<string, number>> = { seven_day: 7 * DAY, seven_day_opus: 7 * DAY - 1, seven_day_sonnet: 7 * DAY - 2, five_hour: 5 * 36e5 };
// unknown lengths (a 30-day) lead, as v1's RANK put them
const lengthOf = (id: string): number => LENGTH[id] ?? (Number(/^w(\d+)m$/.exec(id)?.[1]) * 60_000 || Number.MAX_SAFE_INTEGER);
/** [window, used], longest window first */
const planList = (p: Plan | undefined): [string, number][] =>
  Object.entries(p ?? {})
    .filter(([, x]) => x > 0)
    .sort((a, b) => lengthOf(b[0]) - lengthOf(a[0]));

/** "<1%", never a rounded 100% that isn't all of it */
export const pct = (x: number): string => (x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.99 ? '99%' : `${Math.round(x * 100)}%`);
/** 38400 → "38k", 1250000 → "1.3M" (v1 tokenWords) */
export function tokenWords(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** The share of the window, 0–1, or undefined when the window isn't known. */
export const contextShare = (c: Context | undefined): number | undefined => (c?.window ? Math.min(1, c.tokens / c.window) : undefined);

/** The plan line's words: "6% of weekly · 21% of 5-hour", the subagents' share in; with none, "1.2M tokens". */
export function planWords(u: RowUsage, t: T): string | undefined {
  const plan = planList(u.usage?.plan ?? u.plan).map(([w, x]) => t('shell.usage.ofWindow', { pct: pct(x), window: windowName(w) }));
  if (plan.length) return plan.join(' · ');
  const tokens = u.usage?.tokens ?? u.tokens ?? 0;
  return tokens > 0 ? t('shell.usage.tokens', { n: tokenWords(tokens) }) : undefined;
}

/** "62% context", "124k context" when the window isn't known, "Compacted" after a compaction. */
export function contextWords(c: Context | undefined, t: T): string | undefined {
  if (!c) return undefined;
  if (!c.tokens) return t('shell.usage.compacted');
  const s = contextShare(c);
  return s !== undefined ? t('shell.usage.context', { n: pct(s) }) : t('shell.usage.context', { n: tokenWords(c.tokens) });
}
export function contextTip(c: Context, t: T): string {
  if (!c.tokens) return t('shell.usage.compactedTip');
  return c.window ? t('shell.usage.contextTipOf', { n: c.tokens.toLocaleString('en-US'), window: tokenWords(c.window) }) : t('shell.usage.contextTip', { n: c.tokens.toLocaleString('en-US') });
}

/** Every turn's tokens: read (cache in), of it from the cache (Claude's per-model counts only), and written. */
export function tokensOf(turns: readonly (TurnStatsLike | undefined)[]): { read: number; cached: number | null; output: number; turns: number } {
  const out = { read: 0, cached: 0, output: 0, turns: 0, split: true };
  for (const st of turns) {
    if (!st) continue;
    out.turns++;
    const models = Object.values(st.models ?? {});
    const m = models.reduce<{ read: number; cached: number; output: number }>((a, x) => ({ read: a.read + n0(x.input) + n0(x.cacheRead) + n0(x.cacheWrite), cached: a.cached + n0(x.cacheRead), output: a.output + n0(x.output) }), { read: 0, cached: 0, output: 0 });
    const read = n0(st.inputTokens) + n0(st.cacheTokens);
    const byModel = models.length > 0 && m.read + m.output >= read + n0(st.outputTokens);
    const own = byModel ? m : { read, cached: 0, output: n0(st.outputTokens) };
    // the usage total won, and runtime folds cache reads and writes together: what came from the cache isn't known
    if (!byModel && n0(st.cacheTokens)) out.split = false;
    out.read += own.read;
    out.cached += own.cached;
    out.output += own.output;
  }
  return { read: out.read, cached: out.split && out.read ? out.cached : null, output: out.output, turns: out.turns };
}

/** The whole of it, for the card: this task's tokens, the plan's windows with the subagents' part, the context, and
 * each subagent (a click opens it). */
export function usageSections(u: RowUsage, turns: readonly (TurnStatsLike | undefined)[], t: T, open: (id: string) => void): TaskUsageSection[] {
  const own = tokensOf(turns);
  const subs = u.subUsage ?? [];
  const subTokens = subs.reduce((a, s) => a + n0(s.tokens), 0);
  const total = u.usage?.tokens ?? n0(u.tokens) + subTokens;
  const row = (label: string, value: string, title?: string): TaskUsageRow => ({ label, value, ...(title && { title }) });
  const tokens: TaskUsageRow[] = [
    ...(total > 0 ? [row(subTokens ? t('shell.usage.tokensWithSubs') : t('shell.usage.tokensRow'), tokenWords(total), subTokens ? t('shell.usage.tokensTipSubs', { n: total.toLocaleString('en-US'), subs: subTokens.toLocaleString('en-US') }) : t('shell.usage.tokensTip', { n: total.toLocaleString('en-US') }))] : []),
    ...(own.read ? [row(t('shell.usage.read'), tokenWords(own.read))] : []),
    ...(own.cached !== null && own.read ? [row(t('shell.usage.fromCache'), pct(own.cached / own.read))] : []),
    ...(own.output ? [row(t('shell.usage.written'), tokenWords(own.output))] : []),
    ...(own.turns ? [row(t('shell.usage.turns'), String(own.turns))] : []),
  ];
  const mine = u.plan ?? {};
  const plan = planList(u.usage?.plan ?? u.plan).map(([w, used]) => {
    const by = n0(mine[w]);
    return row(t('shell.usage.ofRow', { window: windowName(w) }), pct(used), used > by + 1e-9 ? t('shell.usage.planSplit', { own: pct(by), subs: pct(used - by) }) : undefined);
  });
  const c = u.context;
  const share = contextShare(c);
  const context: TaskUsageRow[] = c
    ? [{ ...row(t('shell.usage.inUse'), !c.tokens ? t('shell.usage.compacted') : c.window ? t('shell.usage.of', { n: tokenWords(c.tokens), window: tokenWords(c.window) }) : tokenWords(c.tokens), contextTip(c, t)), ...(share !== undefined && { bar: { share, hi: share >= 0.8 } }) }]
    : [];
  const subRows: TaskUsageRow[] = subs.map((s) => ({
    label: s.name || s.title || t('shell.usage.subagent'),
    value: [n0(s.tokens) ? tokenWords(n0(s.tokens)) : '', ...planList(s.plan).slice(0, 1).map(([w, x]) => t('shell.usage.ofWindow', { pct: pct(x), window: windowName(w) }))].filter(Boolean).join(' · ') || t('shell.usage.none'),
    title: s.samePlan === false ? t('shell.usage.subApart', { title: s.title || s.name }) : t('shell.usage.subOpen', { title: s.title || s.name }),
    onOpen: () => open(s.id),
  }));
  return [
    { title: t('shell.usage.thisTask'), rows: tokens },
    { title: t('shell.usage.plan'), rows: plan },
    { title: t('shell.usage.contextTitle'), rows: context },
    { title: t('shell.usage.subagents'), rows: subRows },
  ];
}

/** The details' usage, or undefined when nothing was measured. */
export function taskUsage(u: RowUsage, turns: () => readonly (TurnStatsLike | undefined)[], t: T, open: (id: string) => void, settings: () => void): TaskUsageProps | undefined {
  const plan = planWords(u, t);
  const ctx = contextWords(u.context, t);
  if (!plan && !ctx) return undefined;
  const share = contextShare(u.context);
  return {
    ...(plan && { plan: { text: plan, title: t('shell.usage.planTip') } }),
    ...(ctx && u.context && { context: { text: ctx, title: t('shell.usage.contextLineTip', { tip: contextTip(u.context, t) }), ...(share !== undefined && { share }), hi: (share ?? 0) >= 0.8 } }),
    sections: () => usageSections(u, turns(), t, open),
    label: t('shell.usage.label'),
    more: { label: t('shell.usage.more'), onClick: settings },
  };
}
