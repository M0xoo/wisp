// Review by another harness (server/services/review.js): who reviews, what a reply becomes, and
// that the setting's values are the ones spells may use. The flow itself (ship → review on the PR
// head → summary) runs through a real server in test/ship.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, REVIEW_VALUES, authorsOf, pickReviewer, readReview, reviewPrompt, reviewView } from '../server/services/review.js';
import { SETTINGS } from '../web/js/spell-schema.js';

const agents = (...ids) => ids.map((id) => ({ id, name: id === 'codex' ? 'Codex' : id, available: true }));

test('another harness than the author: never the one that wrote it, in a fixed order', () => {
  assert.deepEqual(pickReviewer('other', ['claude'], agents('claude', 'codex')), { agent: 'codex', model: '' });
  assert.deepEqual(pickReviewer('other', ['codex'], agents('claude', 'codex')), { agent: 'claude', model: '' });
  // Every harness that wrote a turn is an author.
  assert.deepEqual(pickReviewer('other', ['claude', 'codex'], agents('claude', 'codex', 'copilot')), { agent: 'copilot', model: '' });
  assert.match(pickReviewer('other', ['claude'], agents('claude')).why, /No other harness/);
  // Installed but not available (signed out, missing) doesn't count.
  assert.match(pickReviewer('other', ['claude'], [{ id: 'claude', available: true }, { id: 'codex', available: false }]).why, /No other harness/);
});

test('a picked harness reviews even its own work; off and missing say why', () => {
  assert.deepEqual(pickReviewer('claude', ['claude'], agents('claude', 'codex')), { agent: 'claude', model: '' });
  assert.match(pickReviewer('codex', ['claude'], [{ id: 'codex', name: 'Codex', available: false }]).why, /Codex isn't installed/);
  assert.match(pickReviewer('off', [], agents('claude')).why, /off/);
});

test('authors: the turns’ harnesses, not Auto or wisp', () => {
  assert.deepEqual(authorsOf({ agent: 'auto', turns: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'claude' }] }), ['claude', 'codex']);
  assert.deepEqual(authorsOf({ agent: 'codex', turns: [{}] }), ['codex']);
});

test('a reply becomes findings, high first; junk is null', () => {
  const r = readReview({ summary: 's', findings: [{ severity: 'low', text: 'nit' }, { severity: 'high', file: 'a.js', line: '12', text: 'bug' }, { text: '' }, { severity: 'odd', text: 'x', line: -1 }] });
  assert.equal(r.summary, 's');
  assert.deepEqual(r.findings, [{ severity: 'high', file: 'a.js', line: 12, text: 'bug' }, { severity: 'medium', text: 'x' }, { severity: 'low', text: 'nit' }]);
  assert.equal(readReview({ findings: [] }).summary, 'Nothing to fix.');
  assert.equal(readReview(null), null);
  assert.equal(readReview({ summary: 'no list' }), null);
  assert.equal(readReview({ findings: Array.from({ length: 40 }, () => ({ text: 'x' })) }).findings.length, 20);
});

test('the prompt carries the diff and the tests on the head; the view says if it is of the head', () => {
  const p = reviewPrompt({ title: 'fix "add"', task: 'Fix add', diff: '+a', tests: { verdict: 'fail', command: 'npm test', output: 'boom' } });
  assert.match(p, /You review a pull request another coding agent wrote/);
  assert.match(p, /<tests command="npm test" verdict="fail">\nboom/);
  assert.match(p, /<diff>\n\+a\n<\/diff>/);
  assert.doesNotMatch(reviewPrompt({ diff: '', tests: { verdict: 'skip' } }), /<tests/);
  const s = { pr: { head: 'abc' }, review: { status: 'done', head: 'abc', findings: [], at: 1 } };
  assert.equal(reviewView(s).current, true);
  assert.equal(reviewView({ ...s, pr: { head: 'def' } }).current, false);
  assert.equal(reviewView({}), null);
});

test('the setting’s values are the spell schema’s', () => {
  assert.deepEqual(SETTINGS.review, REVIEW_VALUES);
  assert.deepEqual(REVIEW_VALUES, ['off', 'other', ...HARNESSES]);
});
