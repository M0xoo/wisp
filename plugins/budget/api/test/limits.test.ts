// What each CLI says of its windows, as budget's one report shape (v1 test/budget.test.js and
// test/banked-resets.test.js, their pure cases): Claude's rate_limit_event, Codex's rate_limits and
// its app-server's live answer, and banked resets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bankedAt, claudeLimits, codexBanked, codexLimits, codexLive } from '../src/limits.ts';
import type { Banked } from '../src/limits.ts';

const H = 3600_000;
// What Claude Code 2.1.309 printed on a real run (trimmed ids).
const CLAUDE_EVENT = {
  status: 'allowed_warning',
  resetsAt: 1793192400,
  rateLimitType: 'seven_day',
  utilization: 0.76,
  overageStatus: 'rejected',
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: 1792982400 }, seven_day: { utilization: 0.76, resetsAt: 1793192400 } },
};

test('claude: both windows from its rate_limit_event, in ms; a refusal without a number is full', () => {
  assert.deepEqual(claudeLimits(CLAUDE_EVENT), {
    windows: [
      { id: 'five_hour', used: 0.72, resetsAt: 1792982400_000, ms: 5 * H },
      { id: 'seven_day', used: 0.76, resetsAt: 1793192400_000, ms: 7 * 24 * H },
    ],
    complete: true, // unifiedWindows lists every window (window changes)
  });
  assert.deepEqual(claudeLimits({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792982400 }), { windows: [{ id: 'five_hour', used: 1, resetsAt: 1792982400_000, ms: 5 * H }], rejected: 'five_hour' });
  assert.equal(claudeLimits({ status: 'allowed' }), null, 'nothing to show');
  assert.equal(claudeLimits(null), null);
});

test('codex: primary and secondary from its session file, named by their length', () => {
  const rl = { primary: { used_percent: 41, window_minutes: 300, resets_at: 1792982400 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1793192400 }, rate_limit_reached_type: 'secondary' };
  assert.deepEqual(codexLimits(rl), {
    windows: [
      { id: 'five_hour', used: 0.41, resetsAt: 1792982400_000, ms: 5 * H, slot: 'primary' },
      { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H, slot: 'secondary' },
    ],
    complete: true,
    rejected: 'seven_day',
  });
  // A free plan's month-long window.
  assert.equal(codexLimits({ primary: { used_percent: 56, window_minutes: 43200, resets_at: 1794875575 }, secondary: null })?.windows[0]?.id, 'w43200m');
  assert.equal(codexLimits({ primary: null }), null);
  // "in n seconds" counts from the clock it's given.
  assert.equal(codexLimits({ primary: { used_percent: 1, window_minutes: 300, resets_in_seconds: 60 } }, { now: 1000 })?.windows[0]?.resetsAt, 61_000);
});

test('codex: what its app-server reads live becomes the same windows a run reports', () => {
  const res = { rateLimits: { limitId: 'premium', primary: null }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792982400 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793192400 }, rateLimitReachedType: 'rate_limit_reached' } } };
  assert.deepEqual(codexLive(res, { now: 1792000000_000 }), { windows: [{ id: 'five_hour', used: 0.12, resetsAt: 1792982400_000, ms: 5 * H, slot: 'primary' }, { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H, slot: 'secondary' }], complete: true, rejected: 'seven_day' });
  assert.equal(codexLive({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 43200, resetsAt: 1794875575 } } })?.windows[0]?.id, 'w43200m', 'no per-limit list: rateLimits');
  assert.equal(codexLive(null), null);
  assert.equal(codexLive({ rateLimits: { primary: null, secondary: null } }), null);
});

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const snap = (used: number, resetsIn: number, more = {}): Record<string, unknown> => ({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: NOW_S + resetsIn }, ...more });
const primaryOf = (x: Record<string, unknown>): unknown => x['primary'];
const usedOf = (res: unknown): number | undefined => codexLive(res, { now: NOW_MS })?.windows[0]?.used;

test('codexLive: the normal codex entry wins over a later side bucket; a reset just gone isn’t frozen', () => {
  const res = { rateLimits: snap(1, 90_000), rateLimitsByLimitId: { codex: snap(50, 3600), codex_bengalfox: snap(2, 90_000, { normalModelSlug: 'gpt-x' }), other: snap(3, 90_000) } };
  assert.equal(usedOf(res), 0.5);
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -240), other: snap(3, 90_000) } }), 0.5, 'clock skew: 4 minutes back');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } }, other: snap(3, 90_000) } }), 0.5, 'no resets at all: not frozen');
});

test('codexLive: a frozen codex entry gives way to a newer entry or to rateLimits', () => {
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -3600), plus: snap(7, 3600) } }), 0.07, 'a new id');
  assert.equal(usedOf({ rateLimits: snap(9, 3600), rateLimitsByLimitId: { codex: snap(50, -3600) } }), 0.09, 'rateLimits');
  assert.equal(usedOf({ rateLimits: snap(9, 3600), rateLimitsByLimitId: { codex: snap(50, -3600), plus: snap(7, 7200) } }), 0.07, 'the latest reset');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: { primary: primaryOf(snap(50, 3600)), secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: NOW_S - 3600 } }, plus: snap(7, 3600) } }), 0.07, 'one window gone is enough');
});

test('codexLive: a frozen codex entry stays when all there is are side buckets', () => {
  const frozen = snap(50, -3600);
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, spark: snap(2, 3600, { normalModelSlug: 'gpt-x' }) } }), 0.5, 'a model’s own bucket');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, premium: snap(2, 3600) } }), 0.5, 'premium');
  assert.equal(usedOf({ rateLimits: snap(2, 3600, { limitId: 'premium' }), rateLimitsByLimitId: { codex: frozen } }), 0.5, 'premium in rateLimits');
  assert.equal(usedOf({ rateLimits: frozen, rateLimitsByLimitId: { codex: frozen, plus: snap(2, -7200) } }), 0.5, 'as frozen as it is');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, plus: { primary: null } } }), 0.5, 'no usable window');
});

test('codexLive: no codex entry reads rateLimits; garbage reads nothing', () => {
  assert.equal(usedOf({ rateLimits: snap(9, 3600) }), 0.09);
  assert.equal(usedOf({ rateLimits: snap(9, -3600), rateLimitsByLimitId: { other: snap(3, 3600) } }), 0.09, 'as today');
  for (const res of [null, undefined, 'x', 3, {}, { rateLimits: 'x' }, { rateLimitsByLimitId: 'x' }, { rateLimitsByLimitId: { codex: 7 } }]) assert.equal(codexLive(res, { now: NOW_MS }), null, JSON.stringify(res));
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -3600), x: null, y: 'z', w: 3 } }), 0.5, 'junk beside it');
});

// --- A Codex account with no 5-hour window: each shape the answer could take ---------------------

const WEEK_MS = 7 * 24 * H;
const weekly = (used: number, resetsAt: number): Record<string, unknown> => ({ usedPercent: used, windowDurationMins: 10080, resetsAt: Math.floor(resetsAt / 1000) });
const NO_FIVE: Record<string, (w: Record<string, unknown>) => Record<string, unknown>> = {
  'weekly first': (w) => ({ limitId: 'codex', primary: w, secondary: null }),
  'weekly second': (w) => ({ limitId: 'codex', primary: null, secondary: w }),
  'an empty slot first': (w) => ({ limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: w }),
};
const shapes = Object.entries(NO_FIVE);
const answer = (shape: (w: Record<string, unknown>) => Record<string, unknown>, used: number, resetsAt: number): unknown => ({ rateLimitsByLimitId: { codex: shape(weekly(used, resetsAt)) } });

test('no 5-hour window: codexLive reads the one weekly bar, whichever slot it’s in', () => {
  const R = NOW_MS + 3 * 24 * H;
  for (const [name, shape] of shapes) {
    const l = codexLive(answer(shape, 40, R), { now: NOW_MS });
    assert.deepEqual(l?.windows.map(({ id, used, resetsAt, ms }) => ({ id, used, resetsAt, ms })), [{ id: 'seven_day', used: 0.4, resetsAt: R, ms: WEEK_MS }], name);
    assert.equal(l?.complete, true, `${name}: it lists every window, so an old 5-hour one can go`);
    assert.equal(l?.rejected, undefined, name);
    assert.equal(codexLive(answer(shape, 100, R), { now: NOW_MS })?.rejected, 'seven_day', `${name}: full`);
    assert.equal(codexLive({ rateLimits: shape(weekly(40, R)) }, { now: NOW_MS })?.windows[0]?.id, 'seven_day', `${name}: under rateLimits alone`);
  }
});

test('no 5-hour window: frozen goes by the weekly reset alone', () => {
  const skew = 4 * 60_000;
  const later = NOW_MS + 3 * 24 * H;
  for (const [name, shape] of shapes) {
    const moved = (ours: number, theirs: number): number | undefined => usedOf({ rateLimitsByLimitId: { codex: shape(weekly(ours, NOW_MS - H)), plus: shape(weekly(theirs, later)) } });
    assert.equal(moved(50, 7), 0.07, `${name}: reset gone, the new id takes over`);
    assert.equal(usedOf({ rateLimits: shape(weekly(9, later)), rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)) } }), 0.09, `${name}: or rateLimits`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, later)), plus: shape(weekly(7, later + H)) } }), 0.5, `${name}: a live entry stays, whatever else is listed`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - skew)), plus: shape(weekly(7, later)) } }), 0.5, `${name}: clock skew isn’t frozen`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)), spark: shape(weekly(2, later)) } }), 0.02, `${name}: an id we don’t know is the new limit`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)), spark: { ...shape(weekly(2, later)), normalModelSlug: 'gpt-x' } } }), 0.5, `${name}: a model’s own bucket never takes over`);
  }
  // A frozen 5-hour-and-weekly entry whose successor has no 5-hour window: the account is on it now.
  const old = { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: NOW_S - 3600 }, secondary: weekly(50, later) };
  const first = NO_FIVE['weekly first'];
  assert.ok(first);
  const next = codexLive({ rateLimitsByLimitId: { codex: old, plus: first(weekly(7, later)) } }, { now: NOW_MS });
  assert.deepEqual(next?.windows.map((w) => [w.id, w.used]), [['seven_day', 0.07]]);
});

test('past your plan: Claude’s extra usage is flagged; “overage” is never a window; Codex credits are read', () => {
  const x = claudeLimits({ ...CLAUDE_EVENT, isUsingOverage: true, overageStatus: 'allowed' });
  assert.equal(x?.overage, true);
  assert.deepEqual(x?.windows.map((w) => w.id), ['five_hour', 'seven_day']);
  assert.equal(claudeLimits(CLAUDE_EVENT)?.overage, undefined, 'isUsingOverage false: on the plan');
  assert.deepEqual(claudeLimits({ status: 'allowed', rateLimitType: 'overage', utilization: 0.2, isUsingOverage: true }), { windows: [], overage: true }, 'the extra-usage allowance is not a plan window');
  assert.equal(claudeLimits({ status: 'rejected', rateLimitType: 'overage', utilization: 1 }), null);
  const rl = (balance: string): Record<string, unknown> => ({ secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1793192400 }, credits: { has_credits: true, unlimited: false, balance } });
  assert.equal(codexLimits(rl('12.5'))?.credits, 12.5);
  assert.equal(codexLimits({ ...rl('1'), credits: { unlimited: true, balance: null } })?.credits, undefined);
});

// --- Banked resets (v1 test/banked-resets.test.js) ------------------------------------------------

const BNOW = Date.UTC(2026, 10, 7, 12, 0);
const sec = (ms: number): number => Math.floor(ms / 1000);
const credit = (id: string, expiresAt: number | null, extra = {}): Record<string, unknown> => ({ id, expiresAt: expiresAt === null ? null : sec(expiresAt), grantedAt: sec(BNOW - 48 * H), resetType: 'codexRateLimits', status: 'available', title: null, description: null, ...extra });
const banked = (summary: unknown, used = 40): unknown => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: sec(BNOW + 3 * 24 * H) } } }, rateLimitResetCredits: summary });

test('codexBanked: credits present, soonest first, with their expiry in ms', () => {
  const b = codexBanked(banked({ availableCount: 2, credits: [credit('b', BNOW + 5 * 24 * H), credit('a', BNOW + 20 * H)] }), { now: BNOW });
  assert.deepEqual(b, { count: 2, credits: [{ id: 'a', expiresAt: sec(BNOW + 20 * H) * 1000 }, { id: 'b', expiresAt: sec(BNOW + 5 * 24 * H) * 1000 }] });
  assert.deepEqual(codexBanked(banked({ availableCount: 1, credits: [credit('n', null)] }), { now: BNOW }), { count: 1, credits: [{ id: 'n', expiresAt: null }] }, 'one that never expires');
  assert.equal(codexBanked(banked({ availableCount: 5, credits: [credit('a', BNOW + 20 * H)] }), { now: BNOW })?.count, 5, 'a capped list keeps the count');
});

test('codexBanked: credits null is the count alone; empty is none listed; no summary is null', () => {
  assert.deepEqual(codexBanked(banked({ availableCount: 3, credits: null }), { now: BNOW }), { count: 3, credits: null });
  assert.deepEqual(codexBanked(banked({ availableCount: 2 }), { now: BNOW }), { count: 2, credits: null }, 'credits left out');
  assert.deepEqual(codexBanked(banked({ availableCount: 0, credits: [] }), { now: BNOW }), { count: 0, credits: [] });
  for (const r of [undefined, null, 'x', {}, { availableCount: 'two' }]) assert.equal(codexBanked(banked(r), { now: BNOW }), null, JSON.stringify(r));
  assert.equal(codexBanked(null), null);
});

test('codexBanked: past dates and credits no longer available don’t count', () => {
  const b = codexBanked(banked({ availableCount: 3, credits: [credit('gone', BNOW - H), credit('ok', BNOW + 30 * H), credit('used', BNOW + 40 * H, { status: 'redeemed' })] }), { now: BNOW });
  assert.deepEqual(b?.credits?.map((c) => c.id), ['ok']);
  assert.equal(b?.count, 2, 'the expired one leaves the count; one the backend still counts stays');
  assert.deepEqual(codexBanked(banked({ availableCount: 1, credits: [credit('gone', BNOW - H)] }), { now: BNOW }), { count: 0, credits: [] });
  // A stored reading ages: what expired since drops out, and nothing left is nothing to show.
  const kept: Banked = { count: 2, credits: [{ id: 'a', expiresAt: BNOW + H }, { id: 'b', expiresAt: BNOW + 30 * H }], at: BNOW };
  assert.deepEqual(bankedAt(kept, BNOW + 2 * H)?.credits?.map((c) => c.id), ['b']);
  assert.equal(bankedAt(kept, BNOW + 2 * H)?.count, 1);
  assert.equal(bankedAt(kept, BNOW + 31 * H), null);
  assert.equal(bankedAt({ count: 0, credits: null }, BNOW), null);
});
