// Compare's numbers (src/compare): totals over a run's turns, the plan share when runs overlap on one
// account, and the sentence against the first run. Every case of v1's test/compare-metrics.test.js.
import { expect, test } from 'vitest';
import { runMetrics } from '../src/compare/metrics.ts';
import { planShares } from '../src/compare/plan-shares.ts';
import { pct } from '../src/compare/receipt.ts';
import { compareRows, type Row, type RowKey } from '../src/compare/rows.ts';
import { compareSentence } from '../src/compare/sentence.ts';
import type { Metrics, PlanShare, Run, RunTurn, TurnStats } from '../src/compare/types.ts';
import { t } from './compare-strings.ts';

const MIN = 60_000;
const T0 = 1_780_000_000_000;
const ids = { n: 0 };
const next = (): number => ++ids.n;

// Turns shaped like stored ones: a Claude result, and Codex's usage with and without stats.totals.
const claudeOld = (costUsd: number, extra: Partial<TurnStats> = {}): TurnStats => ({ durationMs: 60_000, costUsd, inputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 90, outputTokens: 100, ...extra });
const claudeNew = (costUsd: number, counter: number, extra: Partial<TurnStats> = {}): TurnStats => ({ ...claudeOld(costUsd), totals: { costUsd: counter }, ...extra });
const codexOld = (inputTokens: number, outputTokens: number, cachedInputTokens = 0): TurnStats => ({ durationMs: 60_000, inputTokens, outputTokens, ...(cachedInputTokens && { cachedInputTokens }) });
const codexNew = (own: Partial<TurnStats>, totals: Record<string, number>): TurnStats => ({ durationMs: 60_000, ...own, totals: { ...totals, thread: 'th_1' } });
const share = (used: number, window = 'seven_day', account = 'default', agent = 'claude'): PlanShare => ({ agent, account, window, used, resetsAt: T0 + 7 * 24 * 60 * MIN });

type TurnExtra = Partial<Omit<RunTurn, 'endedAt'>> & { endedAt?: number | undefined };
const turn = (stats: TurnStats | null, extra: TurnExtra = {}): RunTurn => {
  const startedAt = extra.startedAt ?? T0;
  const out = { id: `t${next()}`, status: 'done', startedAt, endedAt: startedAt + 10 * MIN, stats, ...extra };
  if ('endedAt' in extra && extra.endedAt === undefined) delete (out as { endedAt?: number }).endedAt;
  return out as RunTurn;
};
const run = (agent: string, turns: RunTurn[], extra: Partial<Run> = {}): Run => ({ id: `s${next()}`, agent, state: 'review', createdAt: T0 + next(), turns, ...extra });
const tests = (passed: number, failed = 0): TurnExtra => ({ presentation: { blocks: [{ type: 'tests', passed, failed }] } });
const cell = (rows: Row[], key: RowKey, i: number): Row['cells'][number] => {
  const c = rows.find((r) => r.key === key)?.cells[i];
  if (!c) throw new Error(`no ${key} cell ${i}`);
  return c;
};
const running = (extra: TurnExtra = {}): RunTurn => ({ id: 'r', status: 'running', startedAt: T0, ...extra }) as RunTurn;

test('time sums every turn, and a turn with no durationMs falls back to its span', () => {
  const m = runMetrics(run('claude', [turn(claudeOld(1, { durationMs: 120_000 })), turn({ costUsd: 2 }, { startedAt: T0 + 20 * MIN, endedAt: T0 + 23 * MIN }), turn(null, { status: 'stopped', startedAt: T0 + 30 * MIN, endedAt: T0 + 31 * MIN })]));
  expect(m.time).toBe(120_000 + 3 * MIN + MIN);
});

test('a running turn adds no time, and no turn counted is null', () => {
  expect(runMetrics(run('claude', [turn(claudeOld(1)), running()])).time).toBe(60_000);
  expect(runMetrics(run('claude', [running()], { state: 'running' })).time).toBe(null);
  expect(runMetrics(run('claude', [], { state: 'running' })).time).toBe(null);
});

test('a harness that reports each turn sums its costs', () => {
  const m = runMetrics(run('opencode', [turn({ durationMs: 1000, costUsd: 0.5 }), turn({ durationMs: 1000, costUsd: 0.7 })]));
  expect(m.cost).toBe(1.2);
  expect(m.costPartial).toBe(false);
});

test('Claude before stats.totals: costUsd is a running total, so each turn is the difference', () => {
  expect(runMetrics(run('claude', [turn(claudeOld(6.38)), turn(claudeOld(19.04)), turn(claudeOld(21.11))])).cost).toBe(21.11);
});

test('Claude before stats.totals: a counter that goes down started over', () => {
  // 5, then a new thread at 2, then 3: own costs 5, 2 and 1.
  expect(runMetrics(run('claude', [turn(claudeOld(5)), turn(claudeOld(2)), turn(claudeOld(3))])).cost).toBe(8);
});

test('Claude with stats.totals: costUsd is its own, and a baseline moves the counter without counting', () => {
  const m = runMetrics(run('claude', [turn({ durationMs: 1000, totals: { costUsd: 9 }, baseline: true }), turn(claudeNew(0.4, 9.4)), turn(claudeNew(0.6, 10))]));
  expect(m.cost).toBe(1);
  expect(m.costPartial, "a baseline isn't a turn with a missing cost").toBe(false);
  // The old format after a baseline differences from the baseline's counter.
  expect(runMetrics(run('claude', [turn({ costUsd: 9, baseline: true }), turn(claudeOld(9.5))])).cost).toBe(0.5);
});

test('old then new Claude turns: the counter carries over', () => {
  expect(runMetrics(run('claude', [turn(claudeOld(4)), turn(claudeNew(1, 5)), turn(claudeOld(5.5))])).cost).toBe(5.5);
});

test('Codex reports no cost: null, shown as a dash', () => {
  const s = run('codex', [turn(codexOld(100, 10))]);
  expect(runMetrics(s).cost).toBe(null);
  expect(runMetrics(s).costPartial).toBe(false);
  expect(cell(compareRows(t, [s], T0), 'cost', 0).text).toBe('—');
});

test('a turn with no cost: sums what is known and says partial', () => {
  const s = run('claude', [turn(claudeNew(1.2, 1.2)), turn(null, { status: 'stopped' })]);
  const m = runMetrics(s);
  expect(m.cost).toBe(1.2);
  expect(m.costPartial).toBe(true);
  const c = cell(compareRows(t, [s], T0), 'cost', 0);
  expect(c.text).toBe('$1.20');
  expect(c.tip).toBe('Some turns reported no cost');
});

test('a running turn does not make the cost partial', () => {
  expect(runMetrics(run('claude', [turn(claudeNew(1, 1)), running()], { state: 'running' })).costPartial).toBe(false);
});

test('Claude tokens and cache sum over turns', () => {
  const m = runMetrics(run('claude', [turn(claudeOld(1)), turn(claudeOld(2))]));
  expect(m.tokens).toBe(2 * (1000 + 100));
  expect(m.cache).toBe(1800 / 2000);
});

test('Codex before stats.totals: tokens are the thread running total', () => {
  const m = runMetrics(run('codex', [turn(codexOld(100, 10, 50)), turn(codexOld(300, 30, 200)), turn(codexOld(350, 40, 210))]));
  expect(m.tokens).toBe(350 + 40);
  expect(m.cache).toBe(210 / 350);
});

test('Codex before stats.totals: a counter that goes down started over, a turn with no usage keeps it', () => {
  const m = runMetrics(run('codex', [turn(codexOld(300, 30)), turn(null, { status: 'stopped' }), turn(codexOld(350, 40)), turn(codexOld(100, 10))]));
  expect(m.tokens).toBe(390 + 110);
});

test('Codex with stats.totals: the turn is already its own, and its counter is totals', () => {
  const m = runMetrics(run('codex', [
    turn(codexOld(100, 10)),
    turn(codexNew({ inputTokens: 50, outputTokens: 5 }, { inputTokens: 150, outputTokens: 15 })),
    turn(codexOld(200, 20)), // an older-format turn after it differences from totals
  ]));
  expect(m.tokens).toBe(110 + 55 + 55);
});

test('copied turns are skipped everywhere but still move a counter', () => {
  const copy = (stats: TurnStats, extra: TurnExtra): RunTurn => turn(stats, { activity: [{ kind: 'run' }], plan: [share(0.5)], ...extra });
  const s = run('claude', [copy(claudeOld(5), { forked: true }), copy(claudeOld(7), { shared: true }), turn(claudeOld(8), { activity: [{ kind: 'read' }] })]);
  const m = runMetrics(s);
  expect([m.cost, m.time, m.tokens, m.steps, m.followUps]).toEqual([1, 60_000, 1100, 1, 0]);
  expect(planShares(t, [s], T0).cells[0]?.text).toBe('—');
  expect(runMetrics(run('codex', [turn(codexOld(100, 10), { forked: true }), turn(codexOld(150, 20))])).tokens).toBe(60);
});

test('steps count tool calls on any harness, and what the runner trimmed', () => {
  const kinds = ['run', 'tool', 'read', 'edit', 'agent', 'web', 'search', 'text', 'error', 'wait', 'ask', 'answer', 'goal', 'background', 'watch'];
  const a = turn(claudeOld(1, { turns: 40 }), { activity: kinds.map((kind) => ({ kind })) });
  const b = turn(claudeOld(2), { activity: [{ kind: 'run' }, { kind: 'text' }], trimmed: 12 });
  expect(runMetrics(run('claude', [a, b])).steps).toBe(7 + 1 + 12);
});

test('files, tests and asks come from the last turn, follow-ups from the uncopied turns', () => {
  const s = run('claude', [
    turn(claudeOld(1), { changes: [{ edits: [{ before: 'a', after: 'b' }] }], activity: [{ kind: 'ask' }], ...tests(1) }),
    turn(claudeOld(2), { changes: [{ edits: [{ before: 'a', after: 'b\nc' }] }, { edits: [] }], activity: [{ kind: 'ask' }, { kind: 'ask' }], ...tests(4, 1) }),
  ]);
  const m = runMetrics(s);
  expect([m.files, m.add, m.del, m.asks, m.followUps]).toEqual([2, 2, 1, 2, 1]);
  expect(m.tests).toEqual({ passed: 4, failed: 1 });
});

test('unfinished: not live, and the last turn failed or was stopped', () => {
  expect(runMetrics(run('claude', [turn(null, { status: 'error' })])).unfinished).toBe(true);
  expect(runMetrics(run('claude', [turn(null, { status: 'stopped' })])).unfinished).toBe(true);
  expect(runMetrics(run('claude', [turn(null, { status: 'stopped' })], { state: 'waiting' })).unfinished).toBe(false);
  expect(runMetrics(run('claude', [turn(null, { status: 'error' }), turn(claudeOld(1))])).unfinished).toBe(false);
});

// Two runs that started together on one account: #sharers gave each half of what moved.
const overlapping = (costA: number, costB: number, shareA = [share(0.02)], shareB = [share(0.02)]): Run[] => [
  run('claude', [turn(claudeNew(costA, costA), { plan: shareA })]),
  run('claude', [turn(claudeNew(costB, costB), { plan: shareB })]),
];
const ESTIMATE = "An estimate. When runs overlap on one account, wisp can only trace what they took together, so this splits the total by each run's cost.";
const NO_COST = "Not every run reported a cost, so wisp can't split the total between them.";
const texts = (p: ReturnType<typeof planShares>): string[] => p.cells.map((c) => c.text);

test('overlapping on one account: the total splits by cost, marked as an estimate', () => {
  const p = planShares(t, overlapping(3, 1), T0);
  expect(texts(p)).toEqual(['≈3% of weekly', '≈1% of weekly']);
  expect(p.cells.every((c) => c.tip === ESTIMATE)).toBe(true);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('overlapping, one share not landed yet: the turn still counts', () => {
  const landed = run('claude', [turn(claudeNew(3, 3), { plan: [share(0.04)] })]);
  const p = planShares(t, [landed, run('claude', [turn(claudeNew(1, 1))])], T0);
  expect(texts(p)).toEqual(['≈3% of weekly', '≈1% of weekly']);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('overlapping with a run still working: a dash for now, no word about the harness', () => {
  const landed = run('claude', [turn(claudeNew(3, 3), { plan: [share(0.04)] })]);
  const live = run('claude', [running()], { state: 'running' });
  const p = planShares(t, [landed, live], T0 + MIN);
  expect(p.cells.map((c) => [c.text, c.tip])).toEqual([['—', ''], ['—', '']]);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('a span still open overlaps up to now', () => {
  const a = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.04)], startedAt: T0, endedAt: T0 + MIN })]);
  const b = run('claude', [turn(claudeNew(1, 1), { startedAt: T0 + 30_000, endedAt: undefined, status: 'running' })]);
  expect(planShares(t, [a, b], T0 + 5 * MIN).total).toBe('Both runs took 4% of weekly.');
});

test('overlapping Codex on one account: dashes and a total', () => {
  const s = (u: number): Run => run('codex', [turn(codexOld(100, 10), { plan: [share(u, 'seven_day', 'default', 'codex')] })]);
  const p = planShares(t, [s(0.02), s(0.02)], T0);
  expect(texts(p)).toEqual(['—', '—']);
  expect(p.cells.every((c) => c.tip === NO_COST)).toBe(true);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('zero total cost: the same dashes', () => {
  const p = planShares(t, overlapping(0, 0), T0);
  expect(texts(p)).toEqual(['—', '—']);
  expect(p.cells[0]?.tip).toBe(NO_COST);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('runs that never overlapped on one account keep their turn.plan', () => {
  const a = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.03)] })]);
  const b = run('claude', [turn(claudeNew(9, 9), { plan: [share(0.01)], startedAt: T0 + 60 * MIN })]);
  const p = planShares(t, [a, b], T0 + 90 * MIN);
  expect(texts(p)).toEqual(['3% of weekly', '1% of weekly']);
  expect(p.cells.map((c) => c.tip)).toEqual(['', '']);
  expect(p.total).toBe('');
});

test('overlapping on different accounts keep their turn.plan', () => {
  const a = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.03, 'seven_day', 'work')], account: 'work' })], { account: 'work' });
  const b = run('claude', [turn(claudeNew(9, 9), { plan: [share(0.01)] })]);
  const p = planShares(t, [a, b], T0);
  expect(texts(p)).toEqual(['3% of weekly', '1% of weekly']);
  expect(p.total).toBe('');
});

test('overlapping on different harnesses keep their turn.plan', () => {
  const a = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.03)] })]);
  const b = run('codex', [turn(codexOld(10, 1), { plan: [share(0.01, 'seven_day', 'default', 'codex')] })]);
  const p = planShares(t, [a, b], T0);
  expect(texts(p)).toEqual(['3% of weekly', '1% of weekly']);
  expect(p.total).toBe('');
});

test('a run with one pooled turn and a later solo one: the split plus its own share', () => {
  const later = turn(claudeNew(5, 8), { plan: [share(0.05)], startedAt: T0 + 60 * MIN });
  const a = run('claude', [turn(claudeNew(3, 3), { plan: [share(0.02)] }), later]);
  const b = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.02)] })]);
  const p = planShares(t, [a, b], T0 + 90 * MIN);
  // The solo turn's cost doesn't weigh on the split: 3:1 of 4%, then its own 5%.
  expect(texts(p)).toEqual(['≈8% of weekly', '≈1% of weekly']);
  expect(p.total).toBe('Both runs took 4% of weekly.');
});

test('the pool covers only some runs: it names them', () => {
  const [a, b] = overlapping(1, 1) as [Run, Run];
  const c = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.01)], startedAt: T0 + 60 * MIN })]);
  const p = planShares(t, [a, b, c], T0 + 90 * MIN);
  expect(p.total).toBe('A and B took 4% of weekly.');
  expect(texts(p)).toEqual(['≈2% of weekly', '≈2% of weekly', '1% of weekly']);
  const d = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.02)] })]);
  expect(planShares(t, [a, b, d], T0).total).toBe('All 3 runs took 6% of weekly.');
});

test('a cell shows the longest window, and no share yet is a dash', () => {
  const s = run('claude', [turn(claudeNew(1, 1), { plan: [share(0.2, 'five_hour'), share(0.03)] })]);
  expect(planShares(t, [s], T0).cells[0]?.text).toBe('3% of weekly');
  const p = planShares(t, [run('claude', [turn(claudeNew(1, 1))]), run('claude', [turn(claudeNew(1, 1))])], T0);
  expect(texts(p)).toEqual(['—', '—']);
  expect(p.total).toBe('');
});

// The sentence.
const said: string[] = [];
const sentence = (runs: readonly (Run | Metrics)[]): string => {
  const out = compareSentence(t, runs);
  said.push(out);
  return out;
};
const NOISE = 'One run each: the same setup varies run to run.';
const same = (cost: number, input: number, ms: number, extra: TurnExtra = {}): RunTurn => turn({ durationMs: ms, costUsd: cost, totals: { costUsd: cost }, inputTokens: input, outputTokens: 0 }, extra);

test('same harness: tokens, cost and time against A', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const b = run('claude', [same(0.6, 380, 240_000)]);
  expect(sentence([a, b])).toBe(`B used 62% fewer tokens, cost 40% less and took 3 min longer than A. ${NOISE}`);
});

test('more, and times in seconds and hours', () => {
  const a = run('claude', [same(1, 1000, 100_000)]);
  expect(sentence([a, run('claude', [same(2, 1500, 60_000)])])).toBe(`B used 50% more tokens, cost 100% more and took 40s less than A. ${NOISE}`);
  expect(sentence([a, run('claude', [same(1, 1000, 100_000 + 65 * MIN)])])).toBe(`B took 1h 5m longer than A. ${NOISE}`);
});

test('a clause needs both sides', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const b = run('claude', [turn({ durationMs: 60_000, inputTokens: 500, outputTokens: 0 })]);
  expect(sentence([a, b])).toBe(`B used 50% fewer tokens than A. ${NOISE}`);
});

test('different harnesses: one clause, no ratio and no percent', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const out = sentence([a, run('codex', [turn(codexOld(100, 10))]), run('opencode', [same(1, 50, 90_000)])]);
  expect(out).toBe(`Different harnesses count differently, so there's no ratio. ${NOISE}`);
  expect(out.includes('%')).toBe(false);
});

test('a live run says nothing, and everything live is empty', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const live = run('claude', [same(1, 10, 1000)], { state: 'running' });
  expect(sentence([a, live])).toBe('');
  expect(sentence([{ ...a, state: 'waiting' }, live])).toBe('');
  expect(sentence([a, live, run('claude', [same(1, 500, 60_000)])])).toBe(`C used 50% fewer tokens than A. ${NOISE}`);
});

test('a run that failed or stopped has no comparison, and names which', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const failed = run('claude', [same(0.1, 10, 1000, { status: 'error' })]);
  expect(sentence([a, failed])).toBe(`B didn't finish, so there's no comparison. ${NOISE}`);
  const stopped = run('claude', [same(0.1, 10, 1000, { status: 'stopped' })], { createdAt: 1 });
  expect(sentence([a, stopped])).toBe(`A didn't finish, so there's no comparison. ${NOISE}`);
});

test('a different number of follow-ups is not the same work', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const b = run('claude', [same(1, 500, 60_000), same(2, 500, 60_000)]);
  expect(sentence([a, b])).toBe(`B had a different number of follow-ups, so it isn't the same work. ${NOISE}`);
});

test('under 5% and under 5 seconds drop', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  expect(sentence([a, run('claude', [same(1.04, 960, 64_000)])])).toBe(`B used about the same tokens and time as A. ${NOISE}`);
  expect(sentence([a, run('claude', [same(1.04, 800, 64_000)])])).toBe(`B used 20% fewer tokens than A. ${NOISE}`);
  expect(sentence([a, run('claude', [same(1, 1000, 65_000)])])).toBe(`B took 5s longer than A. ${NOISE}`);
});

test('three runs: each against A, in order', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const b = run('claude', [same(1, 500, 60_000)]);
  const c = run('claude', [same(1.5, 1000, 60_000)]);
  // Handed over out of order: the letters go by createdAt.
  expect(sentence([c, a, b])).toBe(`B used 50% fewer tokens than A. C cost 50% more than A. ${NOISE}`);
});

test('the tests clause: every finished run green on the same count', () => {
  const green = (): Run => run('claude', [same(1, 1000, 60_000, tests(12))]);
  const [a, b, c] = [green(), green(), green()];
  expect(sentence([a, b])).toBe(`B used about the same tokens and time as A. Both passed 12 tests. ${NOISE}`);
  expect(sentence([a, b, c]).endsWith(`All 3 passed 12 tests. ${NOISE}`)).toBe(true);
  expect(sentence([a, run('claude', [same(1, 1000, 60_000, tests(11))])])).not.toContain('passed');
  expect(sentence([a, run('claude', [same(1, 1000, 60_000, tests(12, 1))])])).not.toContain('passed');
  expect(sentence([a, run('claude', [same(1, 1000, 60_000)])])).not.toContain('passed');
});

test('the sentence takes metrics too', () => {
  const a = run('claude', [same(1, 1000, 60_000)]);
  const b = run('claude', [same(1, 500, 60_000)]);
  expect(compareSentence(t, [a, b].map(runMetrics))).toBe(compareSentence(t, [a, b]));
});

test('every sentence stays neutral and ends on the noise line when it says anything', () => {
  expect(said.length).toBeGreaterThanOrEqual(20);
  for (const s of said) {
    expect(s).not.toMatch(/\b(better|worse|winner|saved|cheaper|faster|best|won|slower)\b/i);
    if (s) expect(s.endsWith(NOISE), s).toBe(true);
  }
});

test('the rows are the same list whatever the runs hold', () => {
  const shape = (rows: Row[]): unknown[] => rows.map((r) => [r.key, r.label, r.tip]);
  const empty = compareRows(t, [run('claude', [], { state: 'running' })], T0);
  const full = compareRows(t, [run('claude', [same(1, 1000, 60_000, tests(1))]), run('codex', [turn(codexOld(10, 1))])], T0);
  expect(shape(empty)).toEqual(shape(full));
  expect(full.map((r) => r.label)).toEqual(['Time', 'Cost', 'Tokens', 'Cache', 'Agent steps', 'Plan', 'Files', 'Tests', 'Asked']);
  expect(full.find((r) => r.label === 'Agent steps')?.tip).toBe('Tools the agent used: commands, reads, edits, searches');
  expect(full.every((r) => r.cells.length === 2)).toBe(true);
  expect(empty.every((r) => r.cells.length === 1)).toBe(true);
});

test('the cells read as before, a dash for what is unknown', () => {
  const s = run('claude', [turn(claudeNew(1.2, 1.2, { durationMs: 95_000 }), { activity: [{ kind: 'run' }], changes: [{ edits: [{ before: 'a', after: 'b' }] }], ...tests(4, 1), plan: [share(0.03)] })]);
  const c = run('codex', [running()], { state: 'running' });
  const rows = compareRows(t, [s, c], T0);
  const text = (key: RowKey): string => cell(rows, key, 0).text;
  expect([text('time'), text('cost'), text('tokens'), text('cache'), text('steps'), text('plan'), text('asks')]).toEqual(['1m 35s', '$1.20', '1k', pct(900 / 1000), '1', '3% of weekly', '0']);
  expect(cell(rows, 'files', 0)).toEqual({ text: '1 +1 −1', files: { n: 1, add: 1, del: 1 } });
  expect(cell(rows, 'tests', 0)).toEqual({ text: '4 ✓ 1 ✗', tests: { passed: 4, failed: 1 } });
  for (const key of ['time', 'cost', 'tokens', 'cache', 'plan', 'tests'] as const) expect(cell(rows, key, 1).text, key).toBe('—');
});

test("a Compact now or Auto's repair turn isn't a follow-up", () => {
  const tn = (extra: TurnExtra = {}): RunTurn => ({ id: 't', status: 'done', startedAt: 1, endedAt: 2, ...extra }) as RunTurn;
  const m = runMetrics({ id: 'a', agent: 'claude', state: 'review', createdAt: 0, turns: [tn(), tn({ by: 'compact' }), tn({ by: 'wisp' }), tn({ by: 'you' })] });
  expect(m.followUps).toBe(1);
});

test("the tests clause waits for every run: three that passed beside a live one isn't \"All 3\"", () => {
  const m = (id: string, createdAt: number, extra: Partial<Metrics> = {}): Metrics => ({ id, agent: 'claude', createdAt, live: false, unfinished: false, time: 1000, cost: 1, tokens: 100, followUps: 0, tests: { passed: 12, failed: 0 }, ...extra });
  const runs = [m('a', 1), m('b', 2), m('c', 3), m('d', 4, { live: true, tests: null })];
  expect(compareSentence(t, runs)).not.toMatch(/passed/);
  expect(compareSentence(t, runs.slice(0, 3))).toMatch(/All 3 passed 12 tests\./);
});
