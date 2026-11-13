// Plan budget's words past the bars (plan.ts; v1 features/budget.js windowLine, bankedHtml, whereHtml, compareHtml).
import { expect, test } from 'vitest';
import { bankedSoon, bankedWords, compareParts, compareWords, overWords, stopLine, whereRows, windowLine, type Compare } from '../src/plan.ts';

const when = (at: number): string => `@${at}`;
const H = 3_600_000;

test('plan_budget_shows_each_accounts_windows_with_banked_codex_resets', () => {
  // the line under each bar: one thing each, no time twice
  expect(windowLine({ used: 0.2 }, null, when)).toBe('New window');
  expect(windowLine({ used: 1, resetsAt: 5 }, null, when)).toBe('Used up · resets @5');
  expect(windowLine({ used: 0.8, resetsAt: 5 }, 0.75, when)).toBe('Automations wait · resets @5');
  expect(windowLine({ used: 0.1, resetsAt: 5, earlyAt: 2 }, null, when)).toBe('Reset early @2 · resets @5');
  expect(windowLine({ used: 0.5, resetsAt: 5, hitAt: 4 }, null, when)).toBe('Resets @5 · at this pace, runs out @4');
  expect(windowLine({ used: 0.5, resetsAt: 5 }, null, when)).toBe('Resets @5');
  // a harness's own stop line wins over Automations stop at; 'same' follows it; off: never
  expect(stopLine('75', '50')).toBe(0.75);
  expect(stopLine('same', '50')).toBe(0.5);
  expect(stopLine(undefined, 'off')).toBeNull();
  // banked resets: the count, and the next to expire
  const now = 1_000 * H;
  expect(bankedWords(null, now, when)).toBe('');
  expect(bankedWords({ count: 2, credits: null }, now, when)).toBe('2 banked resets');
  expect(bankedWords({ count: 1, credits: [{ id: 'a', expiresAt: now + 2 * H }] }, now, when)).toBe(`1 banked reset, expires @${now + 2 * H}`);
  expect(bankedWords({ count: 2, credits: [{ id: 'a', expiresAt: now - 1 }, { id: 'b', expiresAt: now + 50 * H }] }, now, when)).toBe(`2 banked resets, the next expires @${now + 50 * H}`);
  expect(bankedSoon({ count: 1, credits: [{ id: 'a', expiresAt: now + 2 * H }] }, now)).toBe(true);
  expect(bankedSoon({ count: 1, credits: [{ id: 'a', expiresAt: now + 50 * H }] }, now)).toBe(false);
  expect(overWords({ runs: 2, at: 9, kind: 'credits' }, when)).toBe('2 runs in the last 7 days billed to Codex credits (last: @9).');
});

test('where_your_plan_went_lists_the_top_tasks_the_rest_and_what_ran_outside_wisp', () => {
  expect(whereRows(null)).toBeUndefined();
  const w = whereRows({ window: 'seven_day', label: 'Weekly', used: 0.5, traced: 0.4, tasks: [{ id: 's1', title: 'Fix login', used: 0.25 }, { id: 's2', title: 'Docs', used: 0.1 }], more: 3 });
  expect(w?.heading).toBe('Where the weekly window went');
  expect(w?.rows.map((r) => [r.title, r.pct, r.id ?? ''])).toEqual([
    ['Fix login', '25%', 's1'],
    ['Docs', '10%', 's2'],
    ['3 other tasks', '5%', ''],
    ['Outside wisp or earlier', '10%', ''],
  ]);
});

test('two_accounts_show_tokens_per_model_per_account', () => {
  const c: Compare = {
    model: 'opus',
    accounts: [
      { account: 'w1', turns: 9, output: 19_000, input: 40_000, cache: 0.71 },
      { account: 'default', turns: 12, output: 10_000, input: 38_000, cache: null },
    ],
  };
  const label = (a: string): string => (a === 'w1' ? 'Work' : 'Personal');
  expect(compareWords(c, label)).toBe('Work uses 1.9× the output tokens per turn of Personal (n=9 / 12)');
  expect(compareParts(c.accounts[0] as Compare['accounts'][number])).toEqual(['19k out', '40k in', '71% cache', '9 turns']);
  expect(compareParts(c.accounts[1] as Compare['accounts'][number])).toEqual(['10k out', '38k in', '12 turns']);
  const same: Compare = { model: '', accounts: c.accounts.map((x) => ({ ...x, output: 10_000 })) };
  expect(compareWords(same, label)).toBe('Work and Personal use about the same output tokens per turn (n=9 / 12)');
});
