// Banked Codex resets (server/budget.js codexBanked, server/live-limits.js noteBanked): how many reset
// credits an account has and when each expires, from account/rateLimits/read; Plan budget's line in
// words (web/js/banked.js), and the one phone note per credit the day before it expires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers.js';

const { Budget, codexBanked, bankedAt } = await import('../server/budget.js');
const { createLiveLimits, bankedNote } = await import('../server/live-limits.js');
const { bankedWords, bankedSoon, dayWhen } = await import('../web/js/banked.js');
const { fmtDate, SHORT_TIME } = await import('../web/js/core/format.js');

const H = 3600_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0); // a fixed clock
const sec = (ms) => Math.floor(ms / 1000);
const credit = (id, expiresAt, extra = {}) => ({ id, expiresAt: expiresAt === null ? null : sec(expiresAt), grantedAt: sec(NOW - 48 * H), resetType: 'codexRateLimits', status: 'available', title: null, description: null, ...extra });
const answer = (summary, used = 40) => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: sec(NOW + 3 * 24 * H) } } }, rateLimitResetCredits: summary });

test('codexBanked: credits present, soonest first, with their expiry in ms', () => {
  const b = codexBanked(answer({ availableCount: 2, credits: [credit('b', NOW + 5 * 24 * H), credit('a', NOW + 20 * H)] }), { now: NOW });
  assert.deepEqual(b, { count: 2, credits: [{ id: 'a', expiresAt: sec(NOW + 20 * H) * 1000 }, { id: 'b', expiresAt: sec(NOW + 5 * 24 * H) * 1000 }] });
  const never = codexBanked(answer({ availableCount: 1, credits: [credit('n', null)] }), { now: NOW });
  assert.deepEqual(never, { count: 1, credits: [{ id: 'n', expiresAt: null }] }, 'one that never expires');
  const capped = codexBanked(answer({ availableCount: 5, credits: [credit('a', NOW + 20 * H)] }), { now: NOW });
  assert.equal(capped.count, 5, 'a capped list keeps the count');
});

test('codexBanked: credits null is the count alone; empty is none listed; no summary is null', () => {
  assert.deepEqual(codexBanked(answer({ availableCount: 3, credits: null }), { now: NOW }), { count: 3, credits: null });
  assert.deepEqual(codexBanked(answer({ availableCount: 2 }), { now: NOW }), { count: 2, credits: null }, 'credits left out');
  assert.deepEqual(codexBanked(answer({ availableCount: 0, credits: [] }), { now: NOW }), { count: 0, credits: [] });
  for (const r of [undefined, null, 'x', {}, { availableCount: 'two' }]) assert.equal(codexBanked(answer(r), { now: NOW }), null, JSON.stringify(r));
  assert.equal(codexBanked(null), null);
});

test('codexBanked: past dates and credits no longer available don’t count', () => {
  const b = codexBanked(answer({ availableCount: 3, credits: [credit('gone', NOW - H), credit('ok', NOW + 30 * H), credit('used', NOW + 40 * H, { status: 'redeemed' })] }), { now: NOW });
  assert.deepEqual(b.credits.map((c) => c.id), ['ok']);
  assert.equal(b.count, 2, 'the expired one leaves the count; one the backend still counts stays');
  assert.deepEqual(codexBanked(answer({ availableCount: 1, credits: [credit('gone', NOW - H)] }), { now: NOW }), { count: 0, credits: [] });
  // A stored reading ages: what expired since drops out, and nothing left is nothing to show.
  const kept = { count: 2, credits: [{ id: 'a', expiresAt: NOW + H }, { id: 'b', expiresAt: NOW + 30 * H }], at: NOW };
  assert.deepEqual(bankedAt(kept, NOW + 2 * H).credits.map((c) => c.id), ['b']);
  assert.equal(bankedAt(kept, NOW + 2 * H).count, 1);
  assert.equal(bankedAt(kept, NOW + 31 * H), null);
  assert.equal(bankedAt({ count: 0, credits: null }, NOW), null);
});

test('Plan budget’s line in words: the count, and when the next expires', () => {
  const tomorrow = new Date(NOW + 24 * H);
  tomorrow.setHours(17, 0, 0, 0);
  const at = tomorrow.getTime();
  // The time is in the user's locale: 17:00 here, 05:00 PM on an en-US machine.
  const t = fmtDate(at, SHORT_TIME);
  assert.equal(bankedWords({ count: 1, credits: [{ id: 'a', expiresAt: at }] }, NOW), `1 banked reset, expires tomorrow ${t}`);
  assert.equal(bankedWords({ count: 3, credits: [{ id: 'a', expiresAt: at }] }, NOW), `3 banked resets, the next expires tomorrow ${t}`);
  assert.equal(bankedWords({ count: 2, credits: null }, NOW), '2 banked resets', 'only the count known');
  assert.equal(bankedWords({ count: 1, credits: [{ id: 'n', expiresAt: null }] }, NOW), '1 banked reset', 'never expires');
  assert.equal(bankedWords({ count: 0, credits: [] }, NOW), '');
  assert.equal(bankedWords(null, NOW), '');
  assert.match(dayWhen(NOW + 5 * 24 * H, NOW), /\d\d:\d\d/, 'later than tomorrow: its date');
  assert.doesNotMatch(dayWhen(NOW + 5 * 24 * H, NOW), /today|tomorrow/);
  assert.equal(bankedSoon({ credits: [{ expiresAt: NOW + 20 * H }] }, NOW), true);
  assert.equal(bankedSoon({ credits: [{ expiresAt: NOW + 30 * H }] }, NOW), false);
});

// A reader on its own clock that sends notes to h.notes; h.phone: whether the phone is set up.
function rig() {
  const h = { now: NOW, notes: [], phone: true, reads: 0, summary: null };
  h.budget = new Budget(tmp('banked'), { now: () => h.now });
  h.live = createLiveLimits({
    store: { config: { defaults: { liveLimits: 'on' } } },
    budget: h.budget,
    accounts: { supports: () => false, envFor: () => ({}) },
    waiting: () => true,
    now: () => h.now,
    read: async () => {
      h.reads++;
      return answer(h.summary);
    },
    notify: (note) => (h.phone ? (h.notes.push(note), Promise.resolve()) : null),
  });
  return h;
}

test('a read keeps the banked resets; Plan budget’s view has them for Codex', async () => {
  const h = rig();
  h.summary = { availableCount: 1, credits: [credit('c1', NOW + 3 * 24 * H)] };
  await h.live.tick();
  const v = h.budget.view('codex')[0];
  assert.equal(v.banked.count, 1);
  assert.equal(v.banked.credits[0].id, 'c1');
  assert.equal(v.windows[0].used, 0.4, 'the windows as before');
  // Only the count: no list on the next read.
  h.now += 11 * 60_000;
  h.summary = { availableCount: 2, credits: null };
  await h.live.tick();
  assert.deepEqual(h.budget.view('codex')[0].banked.credits, null);
  // None left: no line.
  h.now += 11 * 60_000;
  h.summary = { availableCount: 0, credits: [] };
  await h.live.tick();
  assert.equal(h.budget.view('codex')[0].banked, undefined);
});

test('one phone note per credit, the day before it expires, never twice', async () => {
  const h = rig();
  h.summary = { availableCount: 2, credits: [credit('c1', NOW + 30 * H), credit('c2', NOW + 4 * 24 * H)] };
  await h.live.tick();
  assert.equal(h.notes.length, 0, 'more than a day away: nothing yet');
  h.now += 7 * H; // 23 hours left on c1
  h.live.noteBanked();
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].title, /^⏳ A banked Codex reset expires (today|tomorrow) \d\d:\d\d$/);
  assert.match(h.notes[0].text, /never spends one/);
  assert.match(h.notes[0].text, /You have 2 banked resets/);
  for (let i = 0; i < 5; i++) {
    h.now += 60_000;
    h.live.noteBanked();
  }
  assert.equal(h.notes.length, 1, 'once per credit, however many ticks');
  // A new read with the same credit doesn't bring it back.
  h.now += 11 * 60_000;
  await h.live.tick();
  assert.equal(h.notes.length, 1, 'a fresh read of the same credit: still once');
  // The next credit gets its own note in its own last day.
  h.now = NOW + 3 * 24 * H + H;
  await h.live.tick();
  assert.equal(h.notes.length, 2);
  // A wisp that restarts reads the same budget.json: still once each.
  const again = new Budget(h.budget.file.replace(/budget\.json$/, ''), { now: () => h.now });
  assert.deepEqual(again.bankedDue('codex'), []);
});

test('no phone set up: the note waits, and goes once one is', async () => {
  const h = rig();
  h.phone = false;
  h.summary = { availableCount: 1, credits: [credit('c1', NOW + 10 * H)] };
  await h.live.tick();
  h.live.noteBanked();
  assert.equal(h.notes.length, 0);
  h.phone = true;
  h.now += 60_000;
  h.live.noteBanked();
  h.live.noteBanked();
  assert.equal(h.notes.length, 1, 'once the phone is there, once');
  // Past its expiry: nothing more, and the sent mark goes with it.
  h.now = NOW + 11 * H;
  assert.equal(h.live.noteBanked(), 0);
});

test('a credit with no expiry, or only a count, never sends a note', async () => {
  const h = rig();
  h.summary = { availableCount: 3, credits: [credit('n', null)] };
  await h.live.tick();
  h.now += 30 * 24 * H;
  h.live.noteBanked();
  h.summary = { availableCount: 3, credits: null };
  await h.live.tick();
  h.live.noteBanked();
  assert.equal(h.notes.length, 0);
});

test('bankedNote: words with the account’s label, today or tomorrow', () => {
  const at = new Date(NOW);
  at.setHours(23, 30, 0, 0);
  const n = bankedNote({ credit: { id: 'x', expiresAt: at.getTime() }, count: 1, label: 'Work', now: at.getTime() - H });
  assert.equal(n.title, '⏳ A banked Codex (Work) reset expires today 23:30');
  assert.doesNotMatch(n.text, /You have/);
});

test('read only: live-limits never names a consume or redeem method, nor auth.json', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/live-limits.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const methods = [...src.matchAll(/method: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(methods.sort(), ['account/rateLimits/read', 'initialize', 'initialized'], 'the only methods it sends');
  assert.doesNotMatch(src, /rateLimitResetCredit\/|auth\.json/);
});
