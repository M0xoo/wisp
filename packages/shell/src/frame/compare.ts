// Compare runs (v1 compare-metrics.js, F-comp-30): what each run of one ask took over its turns, the table's rows in
// a fixed order (nothing jumps while the runs work), and a neutral sentence against run A that never says which run
// is better. DOM-free. v2's turn stats are each turn's own (the parsers difference running totals), so v1's counter
// trap isn't carried over; the Plan row (shares of a plan window) waits on v2's budget windows per turn.
import { changeFigures, duration } from './rows-view.ts';

export interface CompareTurn {
  readonly status?: string;
  readonly by?: string;
  readonly startedAt?: number;
  readonly endedAt?: number | null;
  readonly stats?: {
    readonly costUsd?: number;
    readonly durationMs?: number;
    readonly ms?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheTokens?: number;
  } | null;
  readonly presentation?: { readonly blocks?: readonly { readonly type: string; readonly passed?: unknown; readonly failed?: unknown }[] } | null;
  readonly changes?: readonly { readonly file: string; readonly edits?: readonly unknown[] }[];
  /** its steps' kinds (the event log): tool calls, reads, edits, asks */
  readonly steps?: readonly string[];
}

export interface CompareRun {
  readonly id: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly state: string;
  readonly turns: readonly CompareTurn[];
}

export interface RunMetrics {
  readonly id: string;
  readonly agent: string;
  readonly live: boolean;
  readonly time: number | null;
  readonly cost: number | null;
  readonly costPartial: boolean;
  readonly tokens: number | null;
  readonly cache: number | null;
  readonly steps: number | null;
  readonly files: number;
  readonly add: number;
  readonly del: number;
  readonly tests: { readonly passed: number; readonly failed: number } | null;
  readonly asks: number;
  readonly followUps: number;
  readonly unfinished: boolean;
}

type T = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const STEP_KINDS = new Set(['run', 'tool', 'read', 'edit', 'agent', 'web', 'search']);
/** a difference under this share says nothing about one run each */
const NEAR = 0.05;
const NEAR_MS = 5000;
export const DASH = '—';

/** the dialog's params: the task it was opened from */
export const parseCompare = (p: unknown): { id: string } => ({ id: String((p as { id?: unknown } | null)?.id ?? '') });

const isLive = (state: string): boolean => state === 'running' || state === 'waiting';
const tidy = (x: number): number => Math.round(x * 1e7) / 1e7;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export const letter = (i: number): string => String.fromCharCode(65 + i);
const byAge = <R extends { readonly createdAt: number }>(list: readonly R[]): R[] => [...list].sort((a, b) => a.createdAt - b.createdAt);

function timeOf(t: CompareTurn): number | null {
  if (t.status === 'running') return null;
  const ms = num(t.stats?.durationMs) ?? num(t.stats?.ms);
  if (ms !== null && ms > 0) return ms;
  return typeof t.endedAt === 'number' && typeof t.startedAt === 'number' ? t.endedAt - t.startedAt : null;
}

function testsOf(t: CompareTurn | undefined): { passed: number; failed: number } | null {
  const tests = (t?.presentation?.blocks ?? []).filter((b) => b.type === 'tests');
  if (!tests.length) return null;
  return { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) };
}

/** One run's numbers: time, cost, tokens and steps over its turns; files, tests and asks are what its last turn left. */
export function runMetrics(r: CompareRun): RunMetrics {
  let time: number | null = null;
  let cost: number | null = null;
  let missing = false;
  let read = 0;
  let cached = 0;
  let output = 0;
  let steps: number | null = null;
  for (const t of r.turns) {
    const ms = timeOf(t);
    if (ms !== null) time = (time ?? 0) + ms;
    const c = num(t.stats?.costUsd);
    if (c !== null) cost = tidy((cost ?? 0) + c);
    else if (t.status !== 'running' && t.endedAt) missing = true;
    read += num(t.stats?.inputTokens) ?? 0;
    cached += num(t.stats?.cacheTokens) ?? 0;
    output += num(t.stats?.outputTokens) ?? 0;
    if (t.steps) steps = (steps ?? 0) + t.steps.filter((k) => STEP_KINDS.has(k)).length;
  }
  const last = r.turns.at(-1);
  const fig = changeFigures(last?.changes ?? []);
  const live = isLive(r.state);
  return {
    id: r.id,
    agent: r.agent,
    live,
    time,
    cost,
    costPartial: cost !== null && missing,
    tokens: read + output || null,
    // a harness that doesn't report cached tokens has no cache number, not 0%
    cache: read && cached ? cached / read : null,
    steps,
    files: fig.files,
    add: fig.plus,
    del: fig.minus,
    tests: testsOf(last),
    asks: (last?.steps ?? []).filter((k) => k === 'ask').length,
    // yours, as the task's summary counts them
    followUps: r.turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length,
    unfinished: !live && (last?.status === 'error' || last?.status === 'stopped'),
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const tokenWords = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

export interface CompareCell {
  readonly text: string;
  /** the files row: +add −del after the count */
  readonly add?: number;
  readonly del?: number;
  readonly tone?: 'good' | 'bad';
  readonly tip?: string;
}

export interface CompareRow {
  readonly key: string;
  readonly label: string;
  readonly tip?: string;
  readonly cells: readonly CompareCell[];
}

/** The table: the same rows in the same order whatever the runs hold, a cell per run in createdAt order. */
export function compareRows(runs: readonly CompareRun[], t: T): CompareRow[] {
  const m = byAge(runs).map(runMetrics);
  const row = (key: string, cell: (x: RunMetrics) => CompareCell | null, tip?: string): CompareRow => ({
    key,
    label: t(`shell.compare.row.${key}`),
    ...(tip && { tip }),
    cells: m.map((x) => cell(x) ?? { text: DASH }),
  });
  return [
    row('time', (x) => (x.time !== null ? { text: duration(x.time) } : null)),
    row('cost', (x) => (x.cost !== null ? { text: `$${x.cost.toFixed(2)}`, ...(x.costPartial && { tip: t('shell.compare.costPartial') }) } : null)),
    row('tokens', (x) => (x.tokens ? { text: tokenWords(x.tokens) } : null)),
    row('cache', (x) => (x.cache !== null ? { text: pct(x.cache) } : null)),
    row('steps', (x) => (x.steps !== null ? { text: String(x.steps) } : null), t('shell.compare.stepsTip')),
    row('files', (x) => ({ text: String(x.files), add: x.add, del: x.del })),
    row('tests', (x) => (x.tests ? { text: `${x.tests.passed} ✓${x.tests.failed ? ` ${x.tests.failed} ✗` : ''}`, tone: x.tests.failed ? 'bad' : 'good' } : null)),
    row('asks', (x) => ({ text: String(x.asks) })),
  ];
}

/** "62% fewer tokens": a percent, never the 100% of a number that isn't gone */
function change(a: number, b: number): number {
  const by = Math.round((Math.abs(b - a) / a) * 100);
  return b < a ? Math.min(by, 99) : by;
}

const listed = (xs: readonly string[], and: string): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ${and} ${xs.at(-1) ?? ''}` : (xs[0] ?? ''));

const spanWords = (ms: number, t: T): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? t('shell.compare.min', { n: m }) : `${Math.floor(m / 60)}h ${m % 60}m`;
};

function deltas(a: RunMetrics, b: RunMetrics, name: string, t: T): string {
  const parts: string[] = [];
  const tokens = (a.tokens ?? 0) > 0 && (b.tokens ?? 0) > 0;
  const time = a.time !== null && b.time !== null;
  if (tokens && a.tokens && b.tokens && Math.abs(b.tokens - a.tokens) / a.tokens >= NEAR)
    parts.push(t(b.tokens < a.tokens ? 'shell.compare.fewerTokens' : 'shell.compare.moreTokens', { n: change(a.tokens, b.tokens) }));
  if (a.cost && a.cost > 0 && b.cost !== null && Math.abs(b.cost - a.cost) / a.cost >= NEAR)
    parts.push(t(b.cost < a.cost ? 'shell.compare.costLess' : 'shell.compare.costMore', { n: change(a.cost, b.cost) }));
  if (time && a.time !== null && b.time !== null && Math.abs(b.time - a.time) >= NEAR_MS)
    parts.push(t(b.time < a.time ? 'shell.compare.tookLess' : 'shell.compare.tookLonger', { span: spanWords(Math.abs(b.time - a.time), t) }));
  if (parts.length) return t('shell.compare.than', { name, parts: listed(parts, t('shell.compare.and')) });
  return tokens && time ? t('shell.compare.same', { name }) : '';
}

/** What can honestly be said against run A, in numbers only; once every run has settled. */
export function compareSentence(runs: readonly CompareRun[], t: T): string {
  const m = byAge(runs).map(runMetrics);
  const [a, ...rest] = m;
  if (!a) return '';
  const said = new Set<string>();
  rest.forEach((b, i) => {
    const name = letter(i + 1);
    if (a.live || b.live) return;
    if (a.unfinished || b.unfinished) said.add(t('shell.compare.unfinished', { who: listed([...(a.unfinished ? ['A'] : []), ...(b.unfinished ? [name] : [])], t('shell.compare.and')) }));
    else if (a.followUps !== b.followUps) said.add(t('shell.compare.followUps', { name }));
    else if (a.agent !== b.agent) said.add(t('shell.compare.harnesses'));
    else said.add(deltas(a, b, name, t));
  });
  const done = m.filter((r) => !r.live && !r.unfinished);
  const passed = done[0]?.tests?.passed ?? 0;
  if (!m.some((r) => r.live) && done.length > 1 && passed > 0 && done.every((r) => r.tests && !r.tests.failed && r.tests.passed === passed)) {
    said.add(t(`shell.compare.${done.length === 2 ? 'both' : 'all'}Passed${passed === 1 ? 'One' : ''}`, { count: done.length, n: passed }));
  }
  said.delete('');
  return said.size ? [...said, t('shell.compare.noise')].join(' ') : '';
}
