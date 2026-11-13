// Compare runs' numbers (src/frame/compare.ts, v1 compare-metrics.js): fixed rows, honest cells, a neutral sentence.
import { expect, test } from 'vitest';
import { compareRows, compareSentence, newGroup, nextRun, planShares, runMetrics, windowName, type CompareRun } from '../src/frame/compare.ts';
import { create } from '../src/frame/commands.ts';
import { wireOf } from './command.ts';
import { SHELL_STRINGS } from '../src/i18n/en.ts';

const t = (key: string, p: Readonly<Record<string, string | number>> = {}): string =>
  String((SHELL_STRINGS as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ''));

const turn = (o: Record<string, unknown> = {}): CompareRun['turns'][number] => ({
  status: 'done',
  startedAt: 0,
  endedAt: 60_000,
  stats: { costUsd: 0.5, inputTokens: 9000, outputTokens: 1000, cacheTokens: 4500 },
  ...o,
});
const run = (id: string, createdAt: number, o: Partial<CompareRun> = {}): CompareRun => ({ id, agent: 'claude', createdAt, state: 'review', turns: [turn()], ...o });

test('the rows stay in one order whatever the runs hold; a missing number is a dash, never 0_v1_compare_rows', () => {
  const live = run('b', 2, { state: 'running', turns: [turn({ status: 'running', endedAt: null, stats: null })] });
  const rows = compareRows([live, run('a', 1)], t);
  expect(rows.map((r) => r.key)).toEqual(['time', 'cost', 'tokens', 'cache', 'steps', 'plan', 'files', 'tests', 'asks']);
  // createdAt order: A first, whatever order the group came in
  expect(rows[0]?.cells.map((c) => c.text)).toEqual(['1m 0s', '—']);
  expect(rows[1]?.cells.map((c) => c.text)).toEqual(['$0.50', '—']);
  expect(rows[2]?.cells[0]?.text).toBe('10k');
  expect(rows[3]?.cells[0]?.text).toBe('50%');
  // a harness that reports no cached tokens has no cache number
  expect(compareRows([run('a', 1, { turns: [turn({ stats: { costUsd: 1, inputTokens: 10 } })] })], t)[3]?.cells[0]?.text).toBe('—');
  // a turn that ended without a cost: the total says it's partial
  const m = runMetrics(run('a', 1, { turns: [turn(), turn({ stats: { inputTokens: 5 } })] }));
  expect([m.cost, m.costPartial, m.followUps]).toEqual([0.5, true, 1]);
  const tests = compareRows([run('a', 1, { turns: [turn({ presentation: { blocks: [{ type: 'tests', passed: 4, failed: 1 }] }, steps: ['read', 'edit', 'ask', 'text'] })] })], t);
  expect(tests.find((r) => r.key === 'tests')?.cells[0]).toEqual({ text: '4 ✓ 1 ✗', tone: 'bad' });
  expect(tests.find((r) => r.key === 'steps')?.cells[0]?.text).toBe('2');
  expect(tests.find((r) => r.key === 'asks')?.cells[0]?.text).toBe('1');
});

test('the sentence compares in numbers only, says nothing while a run works, and never ratios two harnesses_v1_compare_sentence', () => {
  const a = run('a', 1);
  const b = run('b', 2, { turns: [turn({ endedAt: 30_000, stats: { costUsd: 0.25, inputTokens: 3000, outputTokens: 1000 } })] });
  expect(compareSentence([a, b], t)).toBe('B used 60% fewer tokens, cost 50% less and took 30s less than A. One run each: the same setup varies run to run.');
  expect(compareSentence([a, { ...b, state: 'running' }], t)).toBe('');
  expect(compareSentence([a, { ...b, agent: 'codex' }], t)).toContain("Different harnesses count differently, so there's no ratio.");
  expect(compareSentence([a, { ...b, turns: [turn({ status: 'error' })] }], t)).toContain("B didn't finish");
  expect(compareSentence([a, run('b', 2)], t)).toBe('B used about the same tokens and time as A. One run each: the same setup varies run to run.');
  const passing = turn({ presentation: { blocks: [{ type: 'tests', passed: 1, failed: 0 }] } });
  expect(compareSentence([run('a', 1, { turns: [passing] }), run('b', 2, { turns: [passing] })], t)).toContain('Both passed 1 test.');
});

test('vs + adds the next harness nobody runs yet, then the lead again, never past four; the runs share a group_v1_launcher_vs', () => {
  const here = ['claude', 'codex', 'opencode'];
  expect(nextRun('claude', [], here)).toBe('codex');
  expect(nextRun('claude', ['codex'], here)).toBe('opencode');
  expect(nextRun('claude', ['codex', 'opencode'], here)).toBe('claude'); // all in: another copy of the lead
  expect(nextRun('claude', ['codex', 'opencode', 'claude'], here)).toBeUndefined();
  expect(nextRun('auto', [], here)).toBe('claude'); // Auto picks; a compare run is a harness
  expect(newGroup(new Uint8Array([0, 15, 255]))).toBe('g-000fff');
  // the group goes in runtime's slot on the wire, and on the row at once
  const a = { peer: 'p', id: 'p:1', prompt: 'x', agent: 'codex', mode: 'auto', at: 1, group: 'g-1' };
  expect(wireOf(create)(a)).toEqual({ peer: 'p', id: 'p:1', prompt: 'x', agent: 'codex', mode: 'auto', at: 1, ext: { 'wisp.runtime': { group: 'g-1' } } });
});

test('Plan: a run alone on its account shows its share; runs overlapping on one account split the total by cost, as an estimate_v1_compare_plan', () => {
  const plan = (used: number, window = 'seven_day') => [{ agent: 'claude', account: 'me', window, used }];
  const at = (from: number, to: number, cost: number | null, used: number, account = 'me') =>
    turn({ startedAt: from, endedAt: to, agent: 'claude', account, stats: cost === null ? {} : { costUsd: cost }, plan: plan(used) });
  // apart in time: each its own share, the longest window named
  const apart = planShares([run('a', 1, { turns: [at(0, 10, 1, 0.04)] }), run('b', 2, { turns: [at(20, 30, 1, 0.02)] })], 100, t);
  expect(apart.cells.map((c) => c.text)).toEqual(['4% of weekly', '2% of weekly']);
  expect(apart.total).toBe('');
  // overlapping on one account: what they took together, split by cost (A cost 3×B)
  const both = planShares([run('a', 1, { turns: [at(0, 30, 3, 0.06)] }), run('b', 2, { turns: [at(10, 40, 1, 0.02)] })], 100, t);
  expect(both.cells.map((c) => c.text)).toEqual(['≈6% of weekly', '≈2% of weekly']);
  expect(both.cells[0]?.tip).toContain('An estimate');
  expect(both.total).toBe('Both runs took 8% of weekly.');
  // a run with no cost: no split, and why
  const stuck = planShares([run('a', 1, { turns: [at(0, 30, null, 0.06)] }), run('b', 2, { turns: [at(10, 40, 1, 0.02)] })], 100, t);
  expect(stuck.cells.map((c) => c.text)).toEqual(['—', '—']);
  expect(stuck.cells[0]?.tip).toContain('Not every run reported a cost');
  // on different accounts they never pool
  const two = planShares([run('a', 1, { turns: [at(0, 30, 3, 0.06)] }), run('b', 2, { turns: [at(10, 40, 1, 0.02, 'work')] })], 100, t);
  expect(two.cells.map((c) => c.text)).toEqual(['6% of weekly', '2% of weekly']);
  expect([windowName('five_hour'), windowName('w4320m'), windowName('w300m'), windowName('x')]).toEqual(['5-hour', '3-day', '5-hour', 'plan']);
});
