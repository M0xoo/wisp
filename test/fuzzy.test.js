// The command palette's fuzzy matcher: subsequence matching, ranking and highlighting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOne, fuzzy, highlight } from '../web/js/fuzzy.js';

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
