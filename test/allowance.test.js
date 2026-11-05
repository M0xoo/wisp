// Allowance per window (server/allowance.js): what each turn cost, each window's periods, and the
// weekly reading that stays silent until there is enough to say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowance, MIN_SHARE, periodsOf, shrinkOf, turnCosts } from '../server/allowance.js';
import { Budget, codexLimits } from '../server/budget.js';
import { tmp } from './helpers.js';

const H = 3600_000;
const WEEK = 7 * 24 * H;
const NOW = 1e12;
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-6, `${why || ''} ${a} ≈ ${b}`);
const cost = (...turns) => {
  const s = { agent: 'claude', turns };
  const m = turnCosts(s);
  return turns.map((t) => m.get(t) || null);
};

test('turnCosts: a turn with totals is its own cost; a resumed older turn is the difference', () => {
  const [a, b, c] = cost({ stats: { costUsd: 1, totals: { costUsd: 5 } } }, { stats: { costUsd: 0.5, totals: { costUsd: 5.5 } } }, { stats: { costUsd: 6 } });
  assert.deepEqual(a, { work: 1, unit: 'usd', rough: false });
  assert.deepEqual(b, { work: 0.5, unit: 'usd', rough: false });
  assert.deepEqual(c, { work: 0.5, unit: 'usd', rough: true }, 'after totals: the difference from them');
  const [one, two, three] = cost({ stats: { costUsd: 1 } }, { stats: { costUsd: 1.3 } }, { stats: { costUsd: 1.6 } });
  assert.deepEqual(one, { work: 1, unit: 'usd', rough: false }, 'nothing before it: its cost is its own');
  assert.deepEqual(two, { work: 0.3, unit: 'usd', rough: true });
  assert.deepEqual(three, { work: 0.3, unit: 'usd', rough: true }, 'no float dust');
});

test('turnCosts: counters that started over count in full', () => {
  const [, b, c] = cost({ stats: { costUsd: 4 } }, { stats: { costUsd: 0.2 } }, { stats: { costUsd: 0.5 } });
  assert.deepEqual(b, { work: 0.2, unit: 'usd', rough: false });
  assert.deepEqual(c, { work: 0.3, unit: 'usd', rough: true }, 'and the next differs from the lower total');
});

test('turnCosts: copies and baselines move the total but aren’t work', () => {
  const [a, b, c] = cost({ forked: true, stats: { costUsd: 3 } }, { forked: true, stats: { costUsd: 4 } }, { stats: { costUsd: 4.5 } });
  assert.deepEqual([a, b], [null, null]);
  assert.deepEqual(c, { work: 0.5, unit: 'usd', rough: true }, 'a fork’s first own turn differences');
  const [x, y] = cost({ forked: true, stats: { costUsd: 0.1, totals: { costUsd: 2 } } }, { stats: { costUsd: 2.5 } });
  assert.equal(x, null);
  assert.deepEqual(y, { work: 0.5, unit: 'usd', rough: true });
  const [base, next] = cost({ stats: { costUsd: 0, baseline: true, totals: { costUsd: 9 } } }, { stats: { costUsd: 0.4, totals: { costUsd: 9.4 } } });
  assert.equal(base, null);
  assert.deepEqual(next, { work: 0.4, unit: 'usd', rough: false });
  const [shared, own] = cost({ shared: true, stats: { costUsd: 2 } }, { stats: { costUsd: 2.5 } });
  assert.equal(shared, null, 'it ran on someone else’s account');
  assert.equal(own.work, 0.5);
});

test('turnCosts: what says nothing gives nothing, and each agent keeps its own total', () => {
  assert.deepEqual(cost({ prompt: 'running' }, { stats: { durationMs: 3 } }), [null, null]);
  assert.equal(turnCosts({ turns: [] }).size, 0);
  assert.equal(turnCosts(null).size, 0);
  const a = { stats: { costUsd: 3 } };
  const other = { agent: 'grok', stats: { inputTokens: 2_000_000, cachedInputTokens: 500_000, outputTokens: 500_000 } };
  const b = { stats: { costUsd: 3.5 } };
  const m = turnCosts({ agent: 'claude', turns: [a, other, b] });
  assert.deepEqual(m.get(other), { work: 2, unit: 'mtok', rough: false });
  assert.deepEqual(m.get(b), { work: 0.5, unit: 'usd', rough: true }, 'another harness between them doesn’t reset it');
});

test('turnCosts: Codex’s usage is the thread’s total, so a follow-up is the difference', () => {
  const stat = (inputTokens, cachedInputTokens, outputTokens) => ({ stats: { inputTokens, cachedInputTokens, outputTokens } });
  const [a, b, failed, c, fresh] = [stat(1_000_000, 200_000, 200_000), stat(1_500_000, 300_000, 300_000), { stats: { durationMs: 5 } }, stat(2_000_000, 500_000, 400_000), stat(100_000, 0, 100_000)];
  const m = turnCosts({ agent: 'codex', turns: [a, b, failed, c, fresh] });
  assert.deepEqual(m.get(a), { work: 1, unit: 'mtok', rough: false });
  assert.deepEqual(m.get(b), { work: 0.5, unit: 'mtok', rough: true });
  assert.equal(m.has(failed), false);
  assert.deepEqual(m.get(c), { work: 0.4, unit: 'mtok', rough: true }, 'a run that never reported doesn’t reset the total');
  assert.deepEqual(m.get(fresh), { work: 0.2, unit: 'mtok', rough: false }, 'a new thread starts over');
});

const plan = (resetsAt, used, more = {}) => ({ agent: 'claude', account: 'default', window: 'seven_day', used, resetsAt, ...more });
const turn = (startedAt, costUsd, more = {}) => ({ startedAt, stats: { costUsd, totals: { costUsd: 0 } }, ...more });
const task = (...turns) => ({ agent: 'claude', account: '', turns });
const win = (over = {}) => ({ id: 'seven_day', used: 0.2, resetsAt: NOW + 2 * 24 * H, ms: WEEK, ...over });
const ends = (n) => NOW - 5 * 24 * H - n * WEEK; // n periods before the current one

test('periodsOf: closed, turn plans and the open window merge on the period’s end', () => {
  const open = win().resetsAt;
  const sessions = [task(turn(open - H, 2, { plan: [plan(open, 0.1)] }), turn(ends(0) - H, 3, { plan: [plan(ends(0), 0.2)] }), turn(ends(1) - H, 1, { plan: [plan(ends(1), 0.1)] }))];
  const closed = [{ resetsAt: ends(0) + 60_000, ms: WEEK, used: 0.5 }]; // Codex drifts: the same period
  const list = periodsOf(sessions, 'claude', 'default', win(), { closed, since: 0, now: NOW });
  assert.deepEqual(list.map((p) => p.end), [open, ends(0) + 60_000, ends(1)], 'newest first');
  const [now, last, older] = list;
  assert.deepEqual([now.open, now.used, now.inWisp, now.full], [true, 0.2, 0.1, undefined]);
  near(now.outside, 0.1);
  assert.deepEqual([last.used, last.inWisp, last.outside, last.work, last.unit, last.full], [0.5, 0.2, 0.3, 3, 'usd', true]);
  near(last.per1, 0.15);
  assert.deepEqual([older.used, older.outside, older.inWisp, older.work, older.full], [null, null, 0.1, 1, undefined], 'known only from its turns');
});

test('periodsOf: inWisp stops at used and at all of it, so outside never goes below zero', () => {
  const end = ends(0);
  const sessions = [task(turn(end - H, 1, { plan: [plan(end, 0.4)] }), turn(end - 2 * H, 1, { plan: [plan(end, 0.3)] }))];
  const [p] = periodsOf(sessions, 'claude', 'default', win({ resetsAt: null }), { closed: [{ resetsAt: end, ms: WEEK, used: 0.5 }], now: NOW });
  assert.deepEqual([p.inWisp, p.outside], [0.5, 0]);
  const [q] = periodsOf([task({ plan: [plan(end, 0.8), plan(end, 0.7)] })], 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.equal(q.inWisp, 1, 'no reading: still at most all of it');
});

test('periodsOf: every turn on the account counts, not only those with a plan row', () => {
  const end = ends(0);
  const sessions = [
    task(turn(end - H, 1, { plan: [plan(end, 0.2)] }), turn(end - 2 * H, 1), turn(end - WEEK + H, 1), turn(end, 1)),
    task(turn(end - WEEK, 5), turn(end + 1, 5), turn(end - H, 5, { account: 'other' }), turn(end - H, 5, { agent: 'codex' })),
    { agent: 'claude', account: 'w', turns: [turn(end - H, 7)] },
    task(turn(end - H, 9, { forked: true, plan: [plan(end, 0.5)] })),
  ];
  const [p] = periodsOf(sessions, 'claude', 'default', win({ resetsAt: null }), { closed: [{ resetsAt: end, ms: WEEK, used: 0.5 }], now: NOW });
  assert.equal(p.work, 4, 'inside (end − ms, end], on this harness and account, copies left out');
  assert.equal(p.inWisp, 0.2);
  const [w] = periodsOf([...sessions, { agent: 'claude', account: 'w', turns: [turn(end - H, 0, { plan: [plan(end, 0.1, { account: 'w' })] })] }], 'claude', 'w', win({ resetsAt: null }), { now: NOW });
  assert.equal(w.work, 7, 'an account of the task’s');
});

test('periodsOf: with no reading, work counts from the first turn that carried a plan row', () => {
  const end = ends(0);
  const sessions = [
    task(turn(end - 6 * 24 * H, 100), turn(end - 24 * H, 200), turn(end - 3 * H, 3, { plan: [plan(end, 0.04)] }), turn(end - 2 * H, 2)),
    task(turn(end - H, 1, { plan: [plan(end, 0.02)] })),
    task(turn(end - 5 * H, 50, { plan: [plan(end, 0.1, { window: 'five_hour' })] }), turn(end - 4 * H, 40, { plan: [plan(end, 0.1, { account: 'other' })] })),
  ];
  const [traced] = periodsOf(sessions, 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.deepEqual([traced.used, traced.inWisp, traced.work], [null, 0.06, 6], 'not the 300 before it, and not 90 from another window’s or account’s row');
  near(traced.per1, 1);
  const [read] = periodsOf(sessions, 'claude', 'default', win({ resetsAt: null }), { closed: [{ resetsAt: end, ms: WEEK, used: 0.5 }], now: NOW });
  assert.deepEqual([read.used, read.work], [0.5, 396], 'a reading covers the whole period, so all its work counts');
  const older = (startedAt, costUsd) => ({ startedAt, stats: { costUsd } });
  const [clean] = periodsOf([task(older(end - 3 * H, 1), older(end - 2 * H, 2), turn(end - H, 1, { plan: [plan(end, 0.1)] }))], 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.deepEqual([clean.work, clean.rough], [1, undefined], 'a difference it didn’t count doesn’t mark it rough');
  const [cli] = periodsOf([task(cliTurn(end - 3 * H, { version: '1' }), cliTurn(end - H, { version: '2' }, { plan: [plan(end, 0.1)] }))], 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.deepEqual(cli.cli, { version: ['1', '2'] }, 'what moved in the CLI still reads the whole period');
});

test('periodsOf: per1 needs a share worth reading, and rough says where a cost came from', () => {
  const end = ends(0);
  const at = (used, more) => periodsOf([task({ startedAt: end - H, stats: { costUsd: 1 } }, { startedAt: end - H, stats: { costUsd: 3 }, plan: [plan(end, used)], ...more })], 'claude', 'default', win({ resetsAt: null }), { now: NOW })[0];
  assert.equal(at(MIN_SHARE - 0.01).per1, null, 'too little to say');
  near(at(MIN_SHARE).per1, 3 / 5);
  assert.equal(at(0.1).rough, true);
  const [none] = periodsOf([task({ plan: [plan(end, 0.5)] })], 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.deepEqual([none.per1, none.rough], [null, undefined], 'no work: no cost');
});

test('periodsOf: full needs a closed, whole period wisp read from its start', () => {
  const end = ends(0);
  const read = (over = {}, opts = {}) => periodsOf([], 'claude', 'default', win({ resetsAt: null }), { closed: [{ resetsAt: end, ms: WEEK, used: 0.5, ...over }], since: end - WEEK, now: NOW, ...opts })[0];
  assert.equal(read().full, true);
  assert.equal(read({ cut: true }).full, undefined, 'cut');
  assert.equal(read({ cut: true }).cut, true);
  assert.equal(read({}, { since: end - WEEK + 1 }).full, undefined, 'wisp began reading it part way');
  assert.equal(read({}, { since: undefined }).full, undefined);
  assert.equal(read({ ms: 30 * 24 * H }).full, undefined, 'another length');
  assert.equal(read({ used: null }).full, undefined, 'no reading');
  // The window now, carried over from a report out of order, is open and neither cut nor full.
  const now = win();
  const [open] = periodsOf([], 'claude', 'default', now, { closed: [{ resetsAt: now.resetsAt, ms: WEEK, used: 0.35, cut: true }], since: 0, now: NOW });
  assert.deepEqual([open.open, open.cut, open.full, open.used], [true, undefined, undefined, 0.35]);
});

test('periodsOf: a cut period stops where the next began, so no turn counts twice', () => {
  const cutAt = NOW - 2 * 24 * H;
  const next = cutAt + WEEK;
  const was = cutAt + 2 * 24 * H; // its reset, had it reached it
  const sessions = [task(turn(cutAt - H, 1, { plan: [plan(was, 0.2)] }), turn(cutAt + H, 2, { plan: [plan(next, 0.1)] }))];
  const [now, cut] = periodsOf(sessions, 'claude', 'default', win({ resetsAt: next, used: 0.1 }), { closed: [{ resetsAt: was, ms: WEEK, used: 0.4, cut: true }], now: NOW });
  assert.deepEqual([now.work, cut.work, cut.cut], [2, 1, true]);
});

test('periodsOf: at most limit, a window with no length from WINDOWS, one with none says nothing', () => {
  const sessions = [task(...Array.from({ length: 20 }, (_, i) => turn(ends(i) - H, 1, { plan: [plan(ends(i), 0.1)] })))];
  const noMs = win({ ms: undefined, resetsAt: null });
  assert.equal(periodsOf(sessions, 'claude', 'default', noMs, { now: NOW }).length, 12);
  const list = periodsOf(sessions, 'claude', 'default', noMs, { now: NOW, limit: 3 });
  assert.deepEqual(list.map((p) => [p.end, p.ms, p.work]), [[ends(0), WEEK, 1], [ends(1), WEEK, 1], [ends(2), WEEK, 1]]);
  const [strange] = periodsOf([task(turn(1, 1, { plan: [plan(2, 0.1, { window: 'w99m' })] }))], 'claude', 'default', { id: 'w99m' }, { now: NOW });
  assert.deepEqual([strange.ms, strange.work, strange.per1], [null, 0, null]);
});

const full = (i, per1, more = {}) => ({ end: ends(i), ms: WEEK, used: 0.5, inWisp: 0.5, outside: 0, work: per1 * 50, unit: 'usd', per1, full: true, ...more });

test('shrinkOf: silent at 3 full periods, speaks at 4, two against two', () => {
  assert.equal(shrinkOf([]), null);
  assert.equal(shrinkOf([full(0, 1), full(1, 1), full(2, 1)]), null);
  const r = shrinkOf([full(0, 1), full(1, 1), full(2, 1), full(3, 1)]);
  assert.deepEqual(r, { state: 'same', change: 0, recent: 1, before: 1, unit: 'usd', from: ends(3) });
  assert.equal(shrinkOf([full(0, 1), full(1, 1), full(2, 1), full(3, 1), full(4, 99)]).state, 'same', 'older ones don’t count');
});

test('shrinkOf: less, same and more at the thresholds', () => {
  const at = (recent, before = 1) => shrinkOf([full(0, recent), full(1, recent), full(2, before), full(3, before)]);
  assert.equal(at(0.8).state, 'less');
  assert.equal(at(0.8).change, -0.2);
  assert.equal(at(0.81).state, 'same');
  assert.equal(at(1.19).state, 'same');
  assert.equal(at(1.2).state, 'more');
  assert.equal(at(0.5).state, 'less');
  // Each side is its work over its share: a big week weighs more than a small one.
  const r = shrinkOf([full(0, 1, { inWisp: 0.1, work: 10 }), full(1, 2, { inWisp: 0.3, work: 60 }), full(2, 1), full(3, 1)]);
  assert.equal(r.recent, 70 / 40);
  assert.equal(r.state, 'more');
});

test('shrinkOf: tiny, unfinished or cut periods aren’t counted, and only weekly windows read', () => {
  const four = [full(0, 1), full(1, 1), full(2, 1), full(3, 1)];
  assert.equal(shrinkOf([...four.slice(0, 3), full(3, 1, { inWisp: 0.09 })]), null, 'under 10% in wisp');
  assert.equal(shrinkOf([...four.slice(0, 3), full(3, 1, { full: undefined })]), null, 'not full');
  assert.equal(shrinkOf([...four.slice(0, 3), full(3, null)]), null, 'no cost');
  assert.equal(shrinkOf(four.map((p) => ({ ...p, ms: 5 * H }))), null, 'a 5-hour window');
  assert.equal(shrinkOf(four.map((p) => ({ ...p, ms: 30 * 24 * H }))), null, 'a 30-day window');
  const skipped = shrinkOf([full(0, 0.5), full(1, 0.5, { full: undefined }), full(2, 0.5), full(3, 1), full(4, 1)]);
  assert.deepEqual([skipped.state, skipped.from], ['less', ends(4)], 'a period that can’t count is stepped over');
  assert.equal(shrinkOf([full(0, 1, { rough: true }), full(1, 1), full(2, 1), full(3, 1)]).rough, true);
});

const cliTurn = (at, cli, more = {}) => ({ startedAt: at, stats: { costUsd: 1, totals: { costUsd: 1 }, ...(cli && { cli }) }, ...more });

test('cli: absent gives no key and no throw', () => {
  const list = periodsOf([task(turn(ends(0) - H, 1, { plan: [plan(ends(0), 0.2)] }), turn(ends(1) - H, 1, { plan: [plan(ends(1), 0.2)] }))], 'claude', 'default', win(), { now: NOW });
  assert.ok(list.every((p) => !('cli' in p)));
  assert.ok(!('cli' in shrinkOf([full(0, 0.5), full(1, 0.5), full(2, 1), full(3, 1)])));
});

test('cli: a period says what moved against the one before, a field only with both sides', () => {
  const sessions = [task(
    cliTurn(ends(2) - H, null, { plan: [plan(ends(2), 0.2)] }),
    cliTurn(ends(1) - 2 * H, { version: '1.0.0', tools: 'a' }, { plan: [plan(ends(1), 0.2)] }),
    cliTurn(ends(0) - 3 * H, { version: '1.0.0', tools: 'a' }, { plan: [plan(ends(0), 0.2)] }),
    cliTurn(ends(0) - 2 * H, { version: '1.1.0', tools: 'a', catalog: 'x' }),
    cliTurn(win().resetsAt - H, { version: '1.2.0', tools: 'b', catalog: 'y' }, { plan: [plan(win().resetsAt, 0.1)] }),
  )];
  const [now, last, first, none] = periodsOf(sessions, 'claude', 'default', win(), { now: NOW });
  assert.deepEqual(now.cli, { version: ['1.1.0', '1.2.0'], tools: true, catalog: true });
  assert.deepEqual(last.cli, { version: ['1.0.0', '1.1.0'] }, 'catalog: nothing to compare it with');
  assert.ok(!('cli' in first), 'nothing before it, and nothing moved inside it');
  assert.ok(!('cli' in none));
  const [inside] = periodsOf([task(cliTurn(ends(0) - 3 * H, { version: '1' }), cliTurn(ends(0) - H, { version: '2' }, { plan: [plan(ends(0), 0.2)] }))], 'claude', 'default', win({ resetsAt: null }), { now: NOW });
  assert.deepEqual(inside.cli, { version: ['1', '2'] }, 'the first of its turns stands in for a period before it');
});

test('shrinkOf: says the moves across its sides, only when it isn’t same', () => {
  const moved = (i, per1, cli) => full(i, per1, { cli });
  const r = shrinkOf([moved(0, 0.5, { version: ['2', '3'] }), moved(1, 0.5, { version: ['1', '2'], tools: true }), full(2, 1), moved(3, 1, { catalog: true })]);
  assert.deepEqual(r.cli, { version: ['1', '3'], tools: true }, 'the oldest period’s own move came before the sides');
  assert.ok(!('cli' in shrinkOf([moved(0, 1, { version: ['1', '2'] }), full(1, 1), full(2, 1), full(3, 1)])), 'same: no cause to name');
  const back = shrinkOf([moved(0, 0.5, { version: ['2', '1'] }), moved(1, 0.5, { version: ['1', '2'] }), full(2, 1), full(3, 1)]);
  assert.ok(!('cli' in back), 'there and back is no move');
});

test('allowance: every account’s windows as the budget has them, by id, end to end', () => {
  let now = NOW;
  const b = new Budget(tmp('allowance'), { now: () => now });
  const report = (used, resetsAt, account = 'default', agent = 'claude') => b.record(agent, account, { windows: [{ id: 'seven_day', used, resetsAt, ms: WEEK }, { id: 'five_hour', used: used / 2, resetsAt: now + H, ms: 5 * H }] });
  const sessions = [];
  // Six weekly periods wisp read whole; 1% costs half as much in the last two.
  const start = now;
  for (let i = 1; i <= 6; i++) {
    const end = start + i * WEEK;
    report(0.01, end);
    sessions.push(task(turn(end - H, i > 4 ? 5 : 10, { plan: [plan(end, 0.4)] })));
    now = end - 30 * 60_000;
    report(0.5, end);
    now = end + 60_000;
  }
  report(0.02, start + 7 * WEEK);
  now += H;
  report(0.03, start + 8 * WEEK, 'work');
  report(0.3, start + 7 * WEEK, 'default', 'codex');
  const out = allowance(b, sessions, { now });
  assert.deepEqual(out.map((a) => [a.agent, a.account]), [['claude', 'default'], ['claude', 'work'], ['codex', 'default']]);
  const week = out[0].windows.find((w) => w.id === 'seven_day');
  assert.equal(week.label, 'Weekly');
  assert.equal(out[0].windows[0].id, 'five_hour', 'in the budget’s order');
  assert.equal(week.periods[0].open, true);
  assert.equal(week.periods[1].used, 0.5);
  assert.deepEqual(week.periods.slice(1, 3).map((p) => [p.full, p.inWisp, p.outside, p.work]), [[true, 0.4, 0.1, 5], [true, 0.4, 0.1, 5]]);
  assert.equal(week.shrink.state, 'less');
  near(week.shrink.change, -0.5);
  assert.equal(out[0].windows[0].shrink, null, 'never for the 5-hour window');
  assert.deepEqual(out[1].windows.map((w) => w.shrink), [null, null], 'another account has its own');
  assert.deepEqual(new Budget(tmp('allowance-none')).state, {});
  assert.deepEqual(allowance(new Budget(tmp('allowance-none')), []), []);
});

test('allowance: a period that ended with no report since still reads as closed', () => {
  let now = NOW;
  const b = new Budget(tmp('allowance-ended'), { now: () => now });
  const end = now + H;
  b.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.6, resetsAt: end, ms: WEEK }] });
  now = end + H;
  const [{ windows: [w] }] = allowance(b, [task(turn(end - 30 * 60_000, 2, { plan: [plan(end, 0.2)] }))], { now });
  assert.deepEqual([w.periods.length, w.periods[0].end, w.periods[0].used, w.periods[0].inWisp, !!w.periods[0].open], [1, end, 0.6, 0.2, false]);
  near(w.periods[0].outside, 0.4);
});

// --- Codex's December plan change ------------------------------------------------------------------

const DAY = 24 * H;
const dec = (m, d, y = 2026) => Date.UTC(y, m, d);
const ending = (ends, per1 = 1) => ends.map((end) => ({ ...full(0, per1), end })); // newest first

test('shrinkOf: Codex, four full periods before December 1 still read', () => {
  const r = shrinkOf(ending([dec(10, 30), dec(10, 23), dec(10, 16), dec(10, 9)]), 'codex');
  assert.equal(r.state, 'same');
  assert.equal(shrinkOf(ending([dec(11, 1), dec(10, 24), dec(10, 17), dec(10, 10)]), 'codex').state, 'same', 'one ending at the very start is still before');
});

test('shrinkOf: Codex says nothing from the first period that ends in December', () => {
  const before = [dec(10, 25), dec(10, 18), dec(10, 11), dec(10, 4)];
  assert.equal(shrinkOf(ending([dec(11, 2), ...before.slice(0, 3)]), 'codex'), null, 'one ending December 2');
  assert.equal(shrinkOf(ending([dec(11, 9), dec(11, 2), ...before]), 'codex'), null, 'two after, older ones behind them');
  assert.equal(shrinkOf(ending([dec(11, 29), dec(11, 22), dec(11, 15), dec(11, 8)]), 'codex'), null, 'four inside December');
  assert.equal(shrinkOf(ending([dec(0, 7, 2027), dec(11, 31), dec(11, 24), dec(11, 17)]), 'codex'), null, 'a period that began in December doesn’t count');
});

test('shrinkOf: Codex reads again on four full periods wholly after January 1', () => {
  const after = [dec(0, 29, 2027), dec(0, 22, 2027), dec(0, 15, 2027), dec(0, 8, 2027)];
  assert.equal(shrinkOf(ending(after), 'codex').state, 'same', 'the first began on January 1');
  assert.equal(shrinkOf(ending(after.slice(0, 3)), 'codex'), null, 'three after, nothing else');
  assert.equal(shrinkOf(ending([...after.slice(0, 3), dec(0, 1, 2027), dec(11, 25), dec(11, 18), dec(11, 11)]), 'codex'), null, 'three after, older ones don’t fill in');
  const r = shrinkOf(ending([...after, dec(0, 1, 2027), dec(11, 25)]).map((p, i) => (i < 2 ? { ...p, per1: 2, work: 100 } : p)), 'codex');
  assert.equal(r.state, 'more', 'only the periods after it, two against two');
  assert.equal(r.from, after[3]);
});

test('shrinkOf: the change is Codex’s; Claude Code, or no agent, reads across December', () => {
  const across = ending([dec(11, 16), dec(11, 9), dec(11, 2), dec(10, 25)]);
  assert.equal(shrinkOf(across, 'claude').state, 'same');
  assert.equal(shrinkOf(across).state, 'same');
});

test('allowance: Codex’s row keeps its periods and only the reading goes quiet', () => {
  let now = dec(11, 10);
  const run = (b, agent) => {
    const start = dec(10, 11);
    const sessions = [];
    now = start - H; // wisp was reading the account before the first of them began
    b.record(agent, 'default', { windows: [{ id: 'seven_day', used: 0.01, resetsAt: start, ms: WEEK }] });
    for (let i = 1; i <= 4; i++) {
      const end = start + i * WEEK;
      now = end - WEEK + H;
      b.record(agent, 'default', { windows: [{ id: 'seven_day', used: 0.01, resetsAt: end, ms: WEEK }] });
      sessions.push({ id: `s${i}`, agent, turns: [{ startedAt: end - H, stats: agent === 'claude' ? { costUsd: 5 } : { inputTokens: 5e6 * i }, plan: [{ agent, account: 'default', window: 'seven_day', used: 0.4, resetsAt: end }] }] });
      now = end - 30 * 60_000;
      b.record(agent, 'default', { windows: [{ id: 'seven_day', used: 0.5, resetsAt: end, ms: WEEK }] });
    }
    now = start + 4 * WEEK + H;
    b.record(agent, 'default', { windows: [{ id: 'seven_day', used: 0.02, resetsAt: start + 5 * WEEK, ms: WEEK }] });
    now += DAY;
    return allowance(b, sessions, { now })[0].windows[0];
  };
  const clock = () => now;
  const claude = run(new Budget(tmp('allowance-dec-claude'), { now: clock }), 'claude');
  assert.equal(claude.shrink?.state, 'same', 'the same periods read for Claude Code');
  const codex = run(new Budget(tmp('allowance-dec-codex'), { now: clock }), 'codex');
  assert.equal(codex.shrink, null);
  assert.ok(codex.periods.filter((p) => p.full).length >= 4, 'its period rows stay');
});

// --- A Codex account with no 5-hour window ------------------------------------------------------------

// What a Codex run reports, with the weekly window in either slot and maybe a 5-hour one first.
const weekOf = (used, end) => ({ used_percent: used * 100, window_minutes: 10080, resets_at: end / 1000 });
const SLOTS = { 'weekly first': (w) => ({ primary: w }), 'weekly second': (w) => ({ secondary: w }) };

test('allowance: a Codex account with no 5-hour window has one weekly row, and Shrink reads it', () => {
  for (const [name, slot] of Object.entries(SLOTS)) {
    let now;
    const b = new Budget(tmp('allowance-no-five'), { now: () => now });
    const start = dec(9, 2); // far from December: nothing here is about the plan change
    const sessions = [];
    now = start - H;
    b.record('codex', 'default', codexLimits(slot(weekOf(0.01, start))));
    for (let i = 1; i <= 4; i++) {
      const end = start + i * WEEK;
      now = end - WEEK + H;
      b.record('codex', 'default', codexLimits(slot(weekOf(0.01, end))));
      const work = i >= 3 ? 10e6 : 5e6; // what 1% buys doubles over the newest two
      sessions.push({ id: `s${i}`, agent: 'codex', turns: [{ startedAt: end - H, stats: { inputTokens: work }, plan: [{ agent: 'codex', account: 'default', window: 'seven_day', used: 0.4, resetsAt: end }] }] });
      now = end - 30 * 60_000;
      b.record('codex', 'default', codexLimits(slot(weekOf(0.5, end))));
    }
    now = start + 4 * WEEK + H;
    b.record('codex', 'default', codexLimits(slot(weekOf(0.02, start + 5 * WEEK))));
    const [row] = allowance(b, sessions, { now });
    assert.deepEqual(row.windows.map((w) => w.id), ['seven_day'], `${name}: no 5-hour row`);
    const [week] = row.windows;
    assert.equal(week.periods.filter((p) => p.full).length, 4, name);
    assert.equal(week.periods.find((p) => p.full).ms, WEEK, `${name}: exactly a week, or Shrink wouldn’t count it`);
    assert.equal(week.shrink?.state, 'more', name);
    near(week.shrink.change, 1, name);
  }
});

test('allowance: Codex losing its 5-hour window in December: quiet through the change, then reads only what came after', () => {
  for (const [name, slot] of Object.entries(SLOTS)) {
    let now;
    const b = new Budget(tmp('allowance-loses-five'), { now: () => now });
    const clear = dec(0, 1, 2027);
    const start = clear - 12 * WEEK;
    const LAST = 6; // the last period with a 5-hour window ends November 20
    const sessions = [];
    const report = (used, end) => {
      const five = { used_percent: 10, window_minutes: 300, resets_at: (now + 2 * H) / 1000 };
      b.record('codex', 'default', codexLimits(end <= start + LAST * WEEK ? { primary: five, secondary: weekOf(used, end) } : slot(weekOf(used, end))));
    };
    const reading = (i) => {
      now = start + i * WEEK + H;
      report(0.02, start + (i + 1) * WEEK);
      return allowance(b, sessions, { now })[0].windows.find((w) => w.id === 'seven_day');
    };
    now = start - H;
    report(0.01, start);
    for (let i = 1; i <= 16; i++) {
      const end = start + i * WEEK;
      now = end - WEEK + H;
      report(0.01, end);
      sessions.push({ id: `s${i}`, agent: 'codex', turns: [{ startedAt: end - H, stats: { inputTokens: i >= 15 ? 10e6 : 5e6 }, plan: [{ agent: 'codex', account: 'default', window: 'seven_day', used: 0.4, resetsAt: end }] }] });
      now = end - 30 * 60_000;
      report(0.5, end);
      const week = reading(i);
      if (i === LAST) assert.equal(week.shrink?.state, 'same', `${name}: with both windows it reads`);
      if (i >= 8 && i <= 15) assert.equal(week.shrink, null, `${name}: period ${i} is quiet`);
      if (i === 16) {
        assert.equal(week.shrink?.state, 'more', `${name}: the newest two against the two before them`);
        assert.equal(week.shrink.from, clear + WEEK, name);
        assert.equal(week.periods.filter((p) => p.full).length >= 4, true, `${name}: rows stay`);
      }
    }
    assert.deepEqual(allowance(b, sessions, { now })[0].windows.map((w) => w.id), ['seven_day'], `${name}: the 5-hour row left`);
  }
});
