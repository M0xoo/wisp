// The command palette's fuzzy matcher: subsequence matching, ranking and highlighting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOne, fuzzy, highlight, recency, byScore } from '../web/js/fuzzy.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rank = (q, titles) =>
  titles
    .map((t) => ({ t, m: fuzzy(q, [t]) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.t);

test('matches subsequences, case-insensitively, and rejects the rest', () => {
  assert.deepEqual(matchOne('stg', 'Settings').idx, [0, 2, 6]);
  assert.ok(matchOne('SET', 'settings'));
  assert.equal(matchOne('xyz', 'Settings'), null);
  assert.equal(matchOne('sgt', 'Settings'), null);
});

test('prefers word starts, prefixes and tight runs', () => {
  assert.deepEqual(rank('rl', ['Add a url parser', 'Rate limiter for login']), ['Rate limiter for login', 'Add a url parser']);
  assert.deepEqual(rank('set', ['Reset password', 'Settings']), ['Settings', 'Reset password']);
  assert.deepEqual(rank('log', ['Blog post tag', 'Login rate limiter']), ['Login rate limiter', 'Blog post tag']);
  // camelCase humps count as word starts
  assert.deepEqual(matchOne('fp', 'fooParser').idx, [0, 3]);
});

test('a substring match picks the occurrence on a word boundary', () => {
  assert.deepEqual(matchOne('art', 'cart').idx, [1, 2, 3]);
  assert.deepEqual(matchOne('art', 'smart art').idx, [6, 7, 8]);
});

test('every query word must match some field; only title hits are highlighted', () => {
  const fields = ['Fix flaky auth test', 'wisp · Review', 'retries the token refresh'];
  const m = fuzzy('auth token', fields);
  assert.ok(m);
  assert.deepEqual(m.idx, [10, 11, 12, 13]);
  assert.equal(fuzzy('auth nope', fields), null);
  assert.ok(fuzzy('wisp flaky', fields).score > 0);
  assert.ok(fuzzy('flaky', fields).score > fuzzy('review', fields).score);
});

test('an empty query matches everything with no highlight', () => {
  assert.deepEqual(fuzzy('   ', ['anything']), { score: 0, idx: [] });
});

test('highlight wraps runs and escapes the text', () => {
  assert.equal(highlight('a<b>c', [0, 1, 4], esc), '<mark>a&lt;</mark>b&gt;<mark>c</mark>');
  assert.equal(highlight('plain', [], esc), 'plain');
});

test('recent items score higher, and the bonus keeps falling with age', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const h = 3.6e6;
  const ages = [0, 1, 12, 24, 72, 24 * 7, 24 * 30, 24 * 365].map((x) => recency(now - x * h, now));
  for (let i = 1; i < ages.length; i++) assert.ok(ages[i] < ages[i - 1], `bonus at step ${i} should drop`);
  assert.ok(ages.at(-1) > 0);
  assert.equal(recency(undefined, now), 0);
  assert.equal(recency(now + h, now), recency(now, now));
});

test('between similar matches the more recent one ranks first', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const day = 864e5;
  const items = [
    { t: 'Fix auth token refresh', at: now - 30 * day },
    { t: 'Auth: rotate keys', at: now - 2 * day },
    { t: 'Add auth to the API', at: now - 3600e3 },
  ];
  const ranked = (list) => list
    .map((x) => ({ ...x, m: fuzzy('auth', [x.t]) }))
    .map((x) => ({ ...x, score: x.m.score + recency(x.at, now) }))
    .sort(byScore)
    .map((x) => x.t);
  assert.deepEqual(ranked(items), ['Add auth to the API', 'Auth: rotate keys', 'Fix auth token refresh']);
  // Same titles: the newest wins outright, whatever order they came in.
  const same = [{ t: 'Deploy', at: now - 5 * day }, { t: 'Deploy', at: now - day }, { t: 'Deploy', at: now - 9 * day }];
  const order = same.map((x) => ({ ...x, score: fuzzy('dep', [x.t]).score + recency(x.at, now) })).sort(byScore).map((x) => x.at);
  assert.deepEqual(order, [now - day, now - 5 * day, now - 9 * day]);
  // Equal scores and no bonus fall back to the timestamp.
  assert.deepEqual([{ score: 1, at: 1 }, { score: 1, at: 2 }].sort(byScore).map((x) => x.at), [2, 1]);
});

test('a much better text match still beats a recent weak one', () => {
  const now = Date.now();
  const strong = fuzzy('settings', ['Settings']).score + recency(now - 864e5 * 60, now);
  const weak = fuzzy('settings', ['Session timeout in tracing logs']);
  assert.ok(!weak || strong > weak.score + recency(now, now));
});
