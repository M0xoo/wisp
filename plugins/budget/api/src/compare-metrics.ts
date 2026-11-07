// Compare's numbers (v1 web/js/compare-metrics.js, "Try it two ways"): what each run of a task took
// over all its turns, its plan share when runs overlap on one account (plan-shares.ts), and a
// neutral sentence against the first run. Pure and DOM-free: the page and the server read it as is.

import { longestFirst, pct, tokenWords } from './receipt.ts';
import { planShares } from './plan-shares.ts';
import { byAge, letter, listed, own, tidy, turnPlan, workOf } from './work.ts';
import type { RunLike, TurnLike } from './work.ts';

export { pct, planShares };

const STEP_KINDS = new Set(['run', 'tool', 'read', 'edit', 'agent', 'web', 'search']);
const NEAR = 0.05; // a difference under this share says nothing about one run each
const NEAR_MS = 5000;
const NOISE = 'One run each: the same setup varies run to run.';
const DASH = '—';

const isLive = (s: RunLike | undefined): boolean => s?.state === 'running' || s?.state === 'waiting';

// Try it two ways: a run's variant in words. Its subagents on the task's model only say so when the
// setting would have them on another (setting: subagentModel).
const SUBAGENT_NAME: Readonly<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet' };
export function variantWords(v: { subagentModel?: string; skills?: string } | null | undefined, setting = ''): string[] {
  const out: string[] = [];
  if (v?.subagentModel) out.push(`Subagents on ${SUBAGENT_NAME[v.subagentModel] ?? v.subagentModel}`);
  else if (v?.subagentModel === '' && setting) out.push('Subagents on task’s model');
  if (v?.skills === 'off') out.push('Skills off');
  return out;
}

const level = (e: string): string => (!e ? 'Default' : e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

/** session.trial.differs in words: "Subagents: Opus → Haiku · Skills: on → off". */
export function differsWords(
  differs: readonly { key: string; values: readonly string[] }[] | null | undefined,
  { agent = (x: string) => x, model = (x: string) => x, account = (x: string) => x || 'Default', taskModel = 'Task’s model' } = {},
): string {
  if (!differs?.length) return 'Same setup on both runs';
  const rows: Record<string, [string, (x: string) => string]> = {
    agent: ['Harness', agent],
    model: ['Model', (x) => (x ? model(x) : 'Default')],
    effort: ['Thinking', level],
    account: ['Account', account],
    subagentModel: ['Subagents', (x) => SUBAGENT_NAME[x] ?? (x || taskModel)],
    skills: ['Skills', (x) => x],
  };
  return differs.map(({ key, values }) => `${rows[key]?.[0] ?? key}: ${values.map(rows[key]?.[1] ?? String).join(' → ')}`).join(' · ');
}

/** What the page's fmtDuration writes. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return `${ms}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The same in a sentence: "40s", "3 min", "1h 5m". */
function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Lines added and removed by a file's edits (v1 web/js/diff.js countChanges, an LCS line diff). */
export function countChanges(edits: readonly { before: string; after: string }[] = []): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const e of edits) {
    const a = e.before === '' ? [] : e.before.split('\n');
    const b = e.after === '' ? [] : e.after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
    const n = endA - start;
    const m = endB - start;
    const common = n * m > 4_000_000 ? 0 : lcs(a.slice(start, endA), b.slice(start, endB));
    add += m - common;
    del += n - common;
  }
  return { add, del };
}

function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Uint32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i--) {
    const cur = new Uint32Array(b.length + 1);
    for (let j = b.length - 1; j >= 0; j--) cur[j] = a[i] === b[j] ? (prev[j + 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j + 1] ?? 0);
    prev = cur;
  }
  return prev[0] ?? 0;
}

function testsOf(t: TurnLike | undefined): { passed: number; failed: number } | null {
  const tests = (t?.presentation?.blocks ?? []).filter((b) => b?.type === 'tests');
  if (!tests.length) return null;
  return { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) };
}

function timeOf(t: TurnLike): number | null {
  if (t.status === 'running') return null;
  const d = t.stats?.durationMs;
  if (typeof d === 'number' && d > 0) return d;
  return t.endedAt ? t.endedAt - (t.startedAt ?? 0) : null;
}

export interface RunMetrics {
  id: string | undefined;
  agent: string | undefined;
  createdAt: number | undefined;
  live: boolean;
  time: number | null;
  cost: number | null;
  costPartial: boolean;
  tokens: number | null;
  cache: number | null;
  steps: number | null;
  plan: { window: string; used: number }[];
  files: number;
  add: number;
  del: number;
  tests: { passed: number; failed: number } | null;
  asks: number;
  followUps: number;
  unfinished: boolean;
}

/** One run's numbers: time, cost, tokens and steps over its turns; files, tests and asks from its last. */
export function runMetrics(session: RunLike): RunMetrics {
  const turns = own(session);
  const work = workOf(session);
  let time: number | null = null;
  let cost: number | null = null;
  let steps: number | null = null;
  let [read, cached, output, missing] = [0, 0, 0, false];
  const plan: Record<string, number> = {};
  for (const t of turns) {
    const ms = timeOf(t);
    if (ms !== null) time = (time ?? 0) + ms;
    const w = work.get(t);
    if (w?.cost != null) cost = tidy((cost ?? 0) + w.cost);
    else if (w && t.status !== 'running' && t.endedAt) missing = true;
    read += w?.tokens.read ?? 0;
    cached += w?.tokens.cached ?? 0;
    output += w?.tokens.output ?? 0;
    steps = (steps ?? 0) + (t.activity ?? []).filter((a) => STEP_KINDS.has(a.kind)).length + (t.trimmed ?? 0);
    for (const p of turnPlan(t)) if (p.window && p.used > 0) plan[p.window] = (plan[p.window] ?? 0) + p.used;
  }
  const last = turns.at(-1);
  const lines = (last?.changes ?? []).reduce((acc, c) => {
    const k = countChanges(c.edits);
    return { add: acc.add + k.add, del: acc.del + k.del };
  }, { add: 0, del: 0 });
  const live = isLive(session);
  return {
    id: session.id, agent: session.agent, createdAt: session.createdAt, live, time, cost,
    costPartial: cost !== null && missing,
    tokens: read + output || null,
    // As on the receipt: a harness that doesn't report cached tokens has no cache number, not 0%.
    cache: read && cached ? cached / read : null,
    steps,
    plan: Object.entries(plan).map(([window, used]) => ({ window, used })).sort(longestFirst),
    files: last?.changes?.length ?? 0,
    ...lines,
    tests: testsOf(last),
    asks: (last?.activity ?? []).filter((a) => a.kind === 'ask').length,
    followUps: turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length, // yours, as in the task's summary
    unfinished: !live && (last?.status === 'error' || last?.status === 'stopped'),
  };
}

/** "62% fewer tokens": a percent, never the 100% of a number that isn't gone. */
function change(a: number, b: number): number {
  const by = Math.round((Math.abs(b - a) / a) * 100);
  return b < a ? Math.min(by, 99) : by;
}

type Compared = Pick<RunMetrics, 'tokens' | 'time' | 'cost'>;
function deltas(a: Compared, b: Compared, name: string): string {
  const parts: string[] = [];
  const at = a.tokens ?? 0;
  const bt = b.tokens ?? 0;
  const tokens = at > 0 && bt > 0;
  if (tokens && Math.abs(bt - at) / at >= NEAR) parts.push(`used ${change(at, bt)}% ${bt < at ? 'fewer' : 'more'} tokens`);
  if (a.cost !== null && a.cost > 0 && b.cost !== null && Math.abs(b.cost - a.cost) / a.cost >= NEAR) parts.push(`cost ${change(a.cost, b.cost)}% ${b.cost < a.cost ? 'less' : 'more'}`);
  const time = a.time !== null && b.time !== null;
  if (a.time !== null && b.time !== null && Math.abs(b.time - a.time) >= NEAR_MS) parts.push(`took ${spanWords(Math.abs(b.time - a.time))} ${b.time < a.time ? 'less' : 'longer'}`);
  if (parts.length) return `${name} ${listed(parts)} than A.`;
  return tokens && time ? `${name} used about the same tokens and time as A.` : '';
}

type SentenceRun = Pick<RunMetrics, 'createdAt' | 'live' | 'unfinished' | 'followUps' | 'agent' | 'tokens' | 'time' | 'cost' | 'tests'>;
const isRun = (x: RunLike | SentenceRun): x is RunLike => 'turns' in x && Array.isArray(x.turns);

/** What can honestly be said against run A, in numbers only. Takes sessions or runMetrics of them. */
export function compareSentence(list: readonly (RunLike | SentenceRun)[]): string {
  const runs: SentenceRun[] = byAge(list).map((x) => (isRun(x) ? runMetrics(x) : x));
  const [a, ...rest] = runs;
  if (!a) return '';
  const said = new Set<string>(); // a clause several runs share is said once
  rest.forEach((b, i) => {
    const name = letter(i + 1);
    if (a.live || b.live) return;
    if (a.unfinished || b.unfinished) said.add(`${listed([...(a.unfinished ? ['A'] : []), ...(b.unfinished ? [name] : [])])} didn't finish, so there's no comparison.`);
    else if (a.followUps !== b.followUps) said.add(`${name} had a different number of follow-ups, so it isn't the same work.`);
    else if (a.agent !== b.agent) said.add("Different harnesses count differently, so there's no ratio.");
    else said.add(deltas(a, b, name));
  });
  const done = runs.filter((r) => !r.live && !r.unfinished);
  const passed = done[0]?.tests?.passed ?? 0;
  if (!runs.some((r) => r.live) && done.length > 1 && passed > 0 && done.every((r) => r.tests && !r.tests.failed && r.tests.passed === passed)) {
    said.add(`${done.length === 2 ? 'Both' : `All ${done.length}`} passed ${passed} test${passed === 1 ? '' : 's'}.`);
  }
  said.delete('');
  return said.size ? [...said, NOISE].join(' ') : '';
}

// The cells are markup the page's Compare table renders as is (v1's exact strings).
const filesHtml = (m: RunMetrics): string => `${m.files} <span class="plus">+${m.add}</span> <span class="minus">−${m.del}</span>`;
const testsHtml = (t: { passed: number; failed: number }): string => `<span class="${t.failed ? 'minus' : 'plus'}">${t.passed} ✓${t.failed ? ` ${t.failed} ✗` : ''}</span>`;

export interface CompareRow {
  key: string;
  label: string;
  tip?: string;
  cells: { html: string; tip?: string }[];
}

/** The table: the same rows in the same order whatever the runs hold, so nothing jumps while they work. */
export function compareRows(sessions: readonly RunLike[], now: number): CompareRow[] {
  const metrics = byAge(sessions).map(runMetrics);
  const { cells: plan } = planShares(sessions, now);
  const row = (key: string, label: string, html: (m: RunMetrics, i: number) => string | null, tip?: string): CompareRow => ({ key, label, ...(tip && { tip }), cells: metrics.map((m, i) => ({ html: html(m, i) ?? DASH })) });
  const rows = [
    row('time', 'Time', (m) => (m.time !== null ? duration(m.time) : null)),
    row('cost', 'Cost', (m) => (m.cost !== null ? `$${m.cost.toFixed(2)}` : null)),
    row('tokens', 'Tokens', (m) => (m.tokens ? tokenWords(m.tokens) : null)),
    row('cache', 'Cache', (m) => (m.cache !== null ? pct(m.cache) : null)),
    row('steps', 'Agent steps', (m) => (m.steps !== null ? String(m.steps) : null), 'Tools the agent used: commands, reads, edits, searches'),
    row('plan', 'Plan', (_m, i) => plan[i]?.text ?? null),
    row('files', 'Files', filesHtml),
    row('tests', 'Tests', (m) => (m.tests ? testsHtml(m.tests) : null)),
    row('asks', 'Asked', (m) => String(m.asks)),
  ];
  const tip = (key: string, fn: (i: number) => string): void =>
    rows.find((r) => r.key === key)?.cells.forEach((c, i) => {
      const t = fn(i);
      if (t) c.tip = t;
    });
  tip('cost', (i) => (metrics[i]?.costPartial ? 'Some turns reported no cost' : ''));
  tip('plan', (i) => plan[i]?.tip ?? '');
  return rows;
}
