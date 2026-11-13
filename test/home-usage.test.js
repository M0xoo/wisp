import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeUsage } from '../web/js/home-usage.js';
import { PARTS } from '../web/js/spell-schema.js';

const win = (id, label, used) => ({ id, label, used, resetsAt: Date.now() + 3600e3 });
const claude = (budget, extra = {}) => ({ id: 'claude', name: 'Claude Code', available: true, budget, ...extra });

test('home usage: the 5-hour window and the fullest weekly one, short labels', () => {
  const [r] = homeUsage([claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.4), win('seven_day', 'Weekly', 0.2), win('seven_day_opus', 'Weekly Opus', 0.7)] }])]);
  assert.deepEqual(r.windows.map((w) => [w.short, w.used]), [['5h', 0.4], ['Opus week', 0.7]]);
});

test('home usage: nothing reported, unavailable or removed accounts show nothing', () => {
  assert.deepEqual(homeUsage([claude([])]), []);
  assert.deepEqual(homeUsage([claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.4)] }], { available: false })]), []);
  assert.deepEqual(homeUsage([claude([{ account: 'gone', windows: [win('five_hour', '5-hour', 0.4)] }])]), []);
});

test('home usage: several accounts each get a row with their label, at most three rows', () => {
  const accounts = [{ id: 'a', label: 'Work' }, { id: 'b', label: 'Home' }];
  const rows = homeUsage([claude([{ account: 'a', windows: [win('five_hour', '5-hour', 0.1)] }, { account: 'b', windows: [win('seven_day', 'Weekly', 0.5)] }], { accounts })]);
  assert.deepEqual(rows.map((r) => [r.accountLabel, r.windows[0].short]), [['Work', '5h'], ['Home', 'Week']]);
  const many = Array.from({ length: 5 }, (_, i) => ({ ...claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.1)] }]), id: `h${i}` }));
  assert.equal(homeUsage(many).length, 3);
});

test('home usage: a spell can reach it', () => {
  assert.equal(PARTS['split.usage'], '#splitHome .sh-usage');
});
