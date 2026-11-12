// Compare runs' numbers (src/frame/compare.ts, v1 compare-metrics.js): fixed rows, honest cells, a neutral sentence.
import { expect, test } from 'vitest';
import { compareRows, compareSentence, runMetrics, type CompareRun } from '../src/frame/compare.ts';
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
  expect(rows.map((r) => r.key)).toEqual(['time', 'cost', 'tokens', 'cache', 'steps', 'files', 'tests', 'asks']);
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
