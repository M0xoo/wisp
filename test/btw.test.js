// /btw side questions: reading the command, the task written out for a run that can't fork the
// conversation, and the answer as markdown (server/btw.js), plus the page's copy of the command
// and its / menu (web/js/slash-text.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btwAnswer, btwDigest, btwPrompt, btwQuestion } from '../server/btw.js';
import * as page from '../web/js/slash-text.js';

test('btwQuestion reads "/btw …" on the server and in the page alike', () => {
  for (const f of [btwQuestion, page.btwQuestion]) {
    assert.equal(f('/btw did you update the docs?'), 'did you update the docs?');
    assert.equal(f('  /BTW   which file?\n'), 'which file?');
    assert.equal(f('/btw\nmultiline\nquestion'), 'multiline\nquestion');
    assert.equal(f('/btw'), '');
    assert.equal(f('/btwx no'), null);
    assert.equal(f('btw did you'), null);
    assert.equal(f('fix it /btw'), null);
    assert.equal(f(undefined), null);
  }
  assert.equal(page.isBtw('/btw '), true);
  assert.equal(page.isBtw('/btwz'), false);
});

test('spellAsk reads "/spell …" in the launcher and follow-ups', () => {
  assert.equal(page.spellAsk('/spell a floating PR button'), 'a floating PR button');
  assert.equal(page.spellAsk('  /SPELL\n  compact cards '), 'compact cards');
  assert.equal(page.spellAsk('/spell'), '');
  assert.equal(page.spellAsk('/spellbook'), null);
  assert.equal(page.spellAsk('cast a /spell'), null);
});

test('the / menu offers the commands a half-typed one could be', () => {
  const names = (t) => page.slashMatches(t).map((c) => c.name);
  assert.deepEqual(names('/'), ['btw', 'goal', 'spell', 'feedback', 'bug']);
  assert.deepEqual(names('/g'), ['goal']);
  assert.equal(page.goalAsk('/goal all tests pass'), 'all tests pass');
  assert.equal(page.goalAsk('/goal'), '');
  assert.equal(page.goalAsk('a /goal'), null);
  assert.ok(page.isGoalDrop('drop') && !page.isGoalDrop('drop the db'));
  assert.deepEqual(names('/s'), ['spell']);
  assert.deepEqual(names('/b'), ['btw', 'bug']);
  assert.deepEqual(names('/bu'), ['bug']);
  assert.deepEqual(names('/F'), ['feedback']);
  assert.deepEqual(names('/btw '), [], 'closed once the command is typed and a space follows');
  assert.deepEqual(names('/x'), []);
  assert.deepEqual(names('hi /b'), []);
});

test('the new-task box offers /goal but not /btw (no run to ask on the side yet)', () => {
  const names = (t) => page.slashMatches(t, page.HOME_SLASH).map((c) => c.name);
  assert.deepEqual(names('/'), ['goal', 'spell', 'feedback', 'bug']);
  assert.deepEqual(names('/b'), ['bug']);
  assert.match(page.HOME_SLASH.find((c) => c.name === 'goal').hint, /Start a task/);
});

const session = {
  agent: 'claude',
  turns: [
    { id: 't1', agent: 'claude', prompt: 'fix the login bug', status: 'done', presentation: { blocks: [{ type: 'hero', title: 'Login fixed', summary: 'Token refresh now retries.', status: 'done' }] }, changes: [{ file: 'src/auth.js', edits: [] }], activity: [] },
    {
      id: 't2',
      agent: 'claude',
      prompt: 'now add tests for @[Login task](wisp:abcdef123456)',
      status: 'running',
      startedAt: Date.now() - 3 * 60_000,
      changes: [{ file: 'test/auth.test.js', edits: [] }],
      activity: [
        { kind: 'read', label: 'Reading src/auth.js' },
        { kind: 'text', label: 'I will cover the retry path first.' },
        { kind: 'run', label: 'Running tests' },
      ],
    },
  ],
};

test('btwDigest writes out the finished turns and what the running one has done so far', () => {
  const d = btwDigest(session, () => 'Claude Code');
  assert.match(d, /### Turn 1 · Claude Code/);
  assert.match(d, /\*\*User:\*\* fix the login bug/);
  assert.match(d, /Login fixed/);
  assert.match(d, /`src\/auth\.js`/);
  assert.match(d, /### Turn 2 · Claude Code · still running \(started 3 min ago\)/);
  assert.match(d, /@Login task \(wisp task abcdef123456\)/);
  assert.match(d, /- Reading src\/auth\.js\n- Running tests/);
  assert.match(d, /\*\*Files it edited so far:\*\* `test\/auth\.test\.js`/);
  assert.match(d, /\*\*Its latest message:\*\* I will cover the retry path first\./);
});

test('btwDigest keeps only the latest turns', () => {
  const many = { agent: 'codex', turns: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, prompt: `step ${i + 1}`, status: 'done', changes: [], activity: [] })) };
  const d = btwDigest(many);
  assert.match(d, /_3 earlier turns left out\._/);
  assert.doesNotMatch(d, /step 3\b/);
  assert.match(d, /step 4[\s\S]*step 7/);
});

test('btwPrompt: a fork only needs the question; a fresh run gets the task too', () => {
  const forked = btwPrompt(session, 'did you touch the docs?', { forked: true });
  assert.match(forked, /^# wisp btw/);
  assert.match(forked, /copy of the conversation/);
  assert.match(forked, /Change nothing/);
  assert.match(forked, /## Side question\n\ndid you touch the docs\?$/);
  assert.doesNotMatch(forked, /The task so far/);
  const fresh = btwPrompt(session, 'did you touch the docs?', { forked: false });
  assert.match(fresh, /## The task so far[\s\S]*fix the login bug[\s\S]*## Side question\n\ndid you touch the docs\?$/);
});

test('btwAnswer keeps plain markdown and renders a wisp block an agent added anyway', () => {
  assert.equal(btwAnswer('  Yes: `docs/a.md` too.\n'), 'Yes: `docs/a.md` too.');
  assert.equal(btwAnswer(''), '_No answer._');
  const md = btwAnswer('Short version below.\n```wisp\n{"blocks":[{"type":"hero","title":"Docs updated","summary":"README and docs/index.html.","status":"done"}]}\n```');
  assert.match(md, /^Short version below\./);
  assert.match(md, /Docs updated/);
  assert.doesNotMatch(md, /```wisp/);
});
