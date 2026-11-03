// Window changes (server/budget.js #shape, web/js/window-notice.js): a plan's usage window that
// appears, goes, changes length or moves its reset off its schedule leaves one notice per window,
// kept across a restart, until it's dismissed. The first report of an account announces nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers.js';

const { Budget, codexLimits, claudeLimits } = await import('../server/budget.js');
const { noticesOf, noticeWords, noticeKey } = await import('../web/js/window-notice.js');

const H = 3600_000;
const D = 24 * H;
const W = 7 * D;
const T0 = Date.UTC(2026, 10, 2, 12);
const THU = Date.UTC(2026, 10, 5, 21); // a Thursday, 21:00 UTC

// A Budget with its own clock and home: what Codex's session file says, and what wisp keeps.
function setup(home = tmp('wn-home')) {
  let t = T0;
  let changes = 0;
  const b = new Budget(home, { now: () => t, onChange: () => changes++ });
  return { b, home, at: (x) => (t = x), get now() { return t; }, get changes() { return changes; } };
}
const codex = (windows) => codexLimits({ ...Object.fromEntries(windows.map(([slot, mins, used, resets]) => [slot, { used_percent: used, window_minutes: mins, resets_at: resets / 1000 }])) });
const notices = (b, agent = 'codex') => b.view(agent).flatMap((x) => x.notices || []);

test('first sighting: nothing to announce, however many windows it has', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 40, THU]]));
  assert.deepEqual(notices(s.b), []);
  // The same windows on the next report, the weekly a little drifted: still nothing.
  s.at(T0 + H);
  s.b.record('codex', 'default', codex([['primary', 300, 12, T0 + 2 * H], ['secondary', 10080, 41, THU + 4 * 60_000]]));
  assert.deepEqual(notices(s.b), []);
});

test('the weekly reset moves off its schedule: one notice with the old time projected to this period', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 40, THU]]));
  // A normal rollover (a week later) is not a change.
  s.at(THU + H);
  s.b.record('codex', 'default', codex([['primary', 300, 1, THU + 4 * H], ['secondary', 10080, 2, THU + W]]));
  assert.deepEqual(notices(s.b), [], 'the next period on the same schedule');
  // Now it resets Sunday 09:00 instead of Thursday 21:00.
  const SUN = Date.UTC(2026, 10, 15, 9);
  s.at(THU + 2 * H);
  s.b.record('codex', 'default', codex([['primary', 300, 2, THU + 4 * H], ['secondary', 10080, 3, SUN]]));
  const [n, ...rest] = notices(s.b);
  assert.equal(rest.length, 0);
  assert.equal(n.kind, 'reset');
  assert.equal(n.window, 'seven_day');
  assert.equal(n.label, 'Weekly');
  assert.equal(n.resetsAt, SUN);
  assert.equal(n.wasResetsAt, THU + W, 'Thursday 21:00 of the same week');
  // The 5-hour window starts at your first message: its reset moving is never a change.
  s.at(THU + 3 * H);
  s.b.record('codex', 'default', codex([['primary', 300, 2, THU + 7 * H + 17 * 60_000], ['secondary', 10080, 3, SUN]]));
  assert.equal(notices(s.b).length, 1);
});

test('a window changes its length: Codex gives it a new id in the same slot', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 40, THU]]));
  s.at(T0 + H);
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 43200, 5, T0 + 30 * D]]));
  const [n, ...rest] = notices(s.b);
  assert.equal(rest.length, 0, 'not a new window and a gone one');
  assert.deepEqual({ kind: n.kind, window: n.window, label: n.label, wasLabel: n.wasLabel, ms: n.ms, wasMs: n.wasMs }, { kind: 'length', window: 'w43200m', label: '30-day', wasLabel: 'Weekly', ms: 30 * D, wasMs: W });
  assert.ok(!s.b.view('codex')[0].windows.some((w) => w.id === 'seven_day'), 'the old window’s bar goes');
});

test('a new window appears after the first sighting; a window goes once several full reports over hours leave it out', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H]]));
  s.at(T0 + H);
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 4, THU]]));
  let [n] = notices(s.b);
  assert.deepEqual({ kind: n.kind, window: n.window, resetsAt: n.resetsAt }, { kind: 'new', window: 'seven_day', resetsAt: THU });
  // Gone: one report without it isn't enough, nor three within minutes.
  for (let i = 1; i <= 3; i++) {
    s.at(T0 + H + i * 60_000);
    s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H]]));
  }
  assert.equal(notices(s.b)[0].kind, 'new', 'three reports within minutes: not gone yet');
  s.at(T0 + 8 * H);
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 10 * H]]));
  [n] = notices(s.b);
  assert.deepEqual({ kind: n.kind, window: n.window, label: n.label }, { kind: 'gone', window: 'seven_day', label: 'Weekly' });
  assert.ok(!s.b.view('codex')[0].windows.some((w) => w.id === 'seven_day'));
});

test('a Claude event naming one window (no unifiedWindows) never makes another one gone or new', () => {
  const s = setup();
  const both = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: (T0 + 2 * H) / 1000 }, seven_day: { utilization: 0.3, resetsAt: THU / 1000 } } };
  s.b.record('claude', 'default', claudeLimits(both));
  for (let i = 1; i <= 6; i++) {
    s.at(T0 + i * 3 * H);
    s.b.record('claude', 'default', claudeLimits({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: (T0 + i * 3 * H + H) / 1000 }));
  }
  assert.deepEqual(notices(s.b, 'claude'), []);
  // A partial event about a window it hadn't seen: no "new" either (only full reports say what exists).
  s.at(T0 + 20 * H);
  s.b.record('claude', 'default', claudeLimits({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.2, resetsAt: THU / 1000 }));
  assert.deepEqual(notices(s.b, 'claude'), []);
  // Nor, since it wasn't counted, gone after full reports leave it out.
  for (let i = 1; i <= 4; i++) {
    s.at(T0 + 20 * H + i * 3 * H);
    s.b.record('claude', 'default', claudeLimits(both));
  }
  assert.deepEqual(notices(s.b, 'claude'), []);
});

test('an early (banked) reset has its own line: no window-change notice for it', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 70, THU]]));
  s.at(T0 + H);
  s.b.record('codex', 'default', codex([['primary', 300, 0, T0 + 6 * H], ['secondary', 10080, 0, T0 + H + W]]));
  assert.ok(s.b.view('codex')[0].windows.find((w) => w.id === 'seven_day').earlyAt, 'seen as an early reset');
  assert.deepEqual(notices(s.b), []);
});

test('kept across a restart, dismissed until the next change of that window', () => {
  const s = setup();
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 40, THU]]));
  s.at(T0 + H);
  s.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 40, THU + 12 * H]]));
  assert.equal(notices(s.b).length, 1);
  // A restart reads budget.json: the notice is still there, and the same report again adds nothing.
  const again = setup(s.home);
  again.at(T0 + 2 * H);
  assert.equal(notices(again.b).length, 1, 'still there after a restart');
  assert.equal(again.b.dismissNotice('codex', 'default', 'seven_day'), true);
  assert.equal(again.b.dismissNotice('codex', 'default', 'seven_day'), false, 'already gone');
  assert.ok(again.changes >= 1, 'the page hears of it');
  again.b.record('codex', 'default', codex([['primary', 300, 10, T0 + 2 * H], ['secondary', 10080, 41, THU + 12 * H]]));
  const third = setup(s.home);
  third.at(T0 + 3 * H);
  third.b.record('codex', 'default', codex([['primary', 300, 11, T0 + 2 * H], ['secondary', 10080, 41, THU + 12 * H]]));
  assert.deepEqual(notices(third.b), [], 'not announced again after a restart');
  // The next change shows again.
  third.b.record('codex', 'default', codex([['primary', 300, 11, T0 + 2 * H], ['secondary', 10080, 41, THU + 36 * H]]));
  assert.equal(notices(third.b)[0].kind, 'reset');
});

test('the page: one line per notice, installed harnesses and accounts still here, in words', () => {
  const n = { window: 'seven_day', kind: 'reset', label: 'Weekly', ms: W, resetsAt: 2, wasResetsAt: 1, at: 5 };
  const agents = [
    { id: 'codex', name: 'Codex', available: true, budget: [{ account: 'default', windows: [], notices: [n] }] },
    { id: 'claude', name: 'Claude Code', available: false, budget: [{ account: 'default', windows: [], notices: [n] }] },
    { id: 'gone', name: 'X', available: true, accounts: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], budget: [{ account: 'z', windows: [], notices: [n] }] },
  ];
  const list = noticesOf(agents);
  assert.equal(list.length, 1, 'not for a harness that isn’t here, nor for a removed account');
  assert.equal(noticeKey(list[0]), 'codex:default:seven_day');
  const when = (t) => ({ 1: 'Thu 21:00', 2: 'Sun 09:00', 3: 'Mon 10:00' })[t];
  assert.equal(noticeWords(list[0], when), 'Codex’s weekly window now resets Sun 09:00 (was Thu 21:00)');
  const w = (x) => noticeWords({ name: 'Codex', accountLabel: '', ...x }, when);
  assert.equal(w({ kind: 'length', label: '30-day', wasLabel: 'Weekly', resetsAt: 3 }), 'Codex’s weekly window is now 30-day, resets Mon 10:00');
  assert.equal(w({ kind: 'new', label: '30-day', resetsAt: 3 }), 'Codex has a new 30-day window, resets Mon 10:00');
  assert.equal(w({ kind: 'gone', label: 'Weekly', accountLabel: 'work' }), 'Codex (work)’s weekly window is gone: it no longer reports one');
});
