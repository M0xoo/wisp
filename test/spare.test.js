// Spare allowance (web/js/spare.js): which windows get split home's card. A long window that resets
// soon with much left; never a 5-hour one, a used-up account, one that runs out first, or one you hid.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { spareOf, spareKey, spareWords, pruneSeen, SPARE_HOURS } = await import('../web/js/spare.js');

const H = 3600_000;
const now = Date.UTC(2026, 10, 2, 12);
const W = 7 * 24 * H;
const win = (id, used, inH, extra = {}) => ({ id, label: id === 'five_hour' ? '5-hour' : 'Weekly', used, resetsAt: now + inH * H, ms: id === 'five_hour' ? 5 * H : W, hitAt: null, ...extra });
const codex = (windows, more = {}) => ({ id: 'codex', name: 'Codex', available: true, budget: [{ account: 'default', at: now - H, windows }], ...more });

test('a weekly window resetting within a day with a fifth or more left gets a card', () => {
  const [c, ...rest] = spareOf([codex([win('five_hour', 0.1, 2), win('seven_day', 0.62, 9)])], { now });
  assert.equal(rest.length, 0, 'the 5-hour window never gets one');
  assert.deepEqual({ agent: c.agent, account: c.account, window: c.window, at: c.at }, { agent: 'codex', account: '', window: 'seven_day', at: now - H });
  assert.equal(Math.round(c.left * 100), 38);
  assert.equal(spareWords(c, 'Thu 21:00'), '38% of Codex’s weekly window is left, resets Thu 21:00');
});

test('no card: too far off, too little left, already reset, runs out first, or the account is used up', () => {
  const one = (w, o) => spareOf([codex(w)], { now, ...o });
  assert.equal(one([win('seven_day', 0.3, SPARE_HOURS + 1)]).length, 0, 'resets in more than a day');
  assert.equal(one([win('seven_day', 0.85, 5)]).length, 0, '15% left');
  assert.equal(one([win('seven_day', 0.8, 5)]).length, 1, 'exactly 20% left counts');
  assert.equal(one([win('seven_day', 0.3, -1)]).length, 0, 'its reset has passed');
  assert.equal(one([win('seven_day', 0.6, 5, { hitAt: now + 3 * H })]).length, 0, 'at this pace it runs out before the reset');
  assert.equal(one([win('five_hour', 1, 2), win('seven_day', 0.3, 5)]).length, 0, 'the 5-hour window is used up: a task now would only wait');
  assert.equal(one([win('seven_day', 0.3, 30)], { hours: 36 }).length, 1, 'split.spare.hours widens it');
  assert.equal(one([{ ...win('seven_day', 0.3, 5), ms: null }]).length, 0, 'a window of unknown length');
  assert.equal(spareOf([codex([win('seven_day', 0.3, 5)], { available: false })], { now }).length, 0, 'a harness not installed here');
});

test('several accounts: a card per account by the launcher’s id and label; a removed one is skipped', () => {
  const a = {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    accounts: [{ id: 'acc1', label: 'work' }, { id: 'acc2', label: 'home' }],
    budget: [
      { account: 'acc2', windows: [win('seven_day', 0.5, 20)] },
      { account: 'acc1', windows: [win('seven_day', 0.1, 4)] },
      { account: 'gone', windows: [win('seven_day', 0.1, 4)] },
    ],
  };
  const cards = spareOf([a], { now });
  assert.deepEqual(cards.map((c) => [c.account, c.accountLabel]), [['acc1', 'work'], ['acc2', 'home']], 'soonest reset first');
  assert.match(spareWords(cards[0], '16:00'), /^90% of Claude Code \(work\)’s weekly window is left/);
});

test('hidden until its next period: the same reset (give or take Codex’s drift) stays hidden, a new one shows', () => {
  const w = win('seven_day', 0.3, 5);
  const [c] = spareOf([codex([w])], { now });
  const seen = { [spareKey(c)]: w.resetsAt + 2 * 60_000 };
  assert.equal(spareOf([codex([w])], { now, seen }).length, 0);
  assert.equal(spareOf([codex([{ ...w, resetsAt: w.resetsAt + W }])], { now: now + W, seen }).length, 1, 'next week’s window');
  assert.deepEqual(pruneSeen(seen, w.resetsAt + H), {}, 'past resets are let go');
  assert.deepEqual(pruneSeen(seen, now), seen);
});
