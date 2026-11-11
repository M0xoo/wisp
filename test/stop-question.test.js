import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopQuestion } from '../web/js/stop-question.js';

test('Stop on a lead asks first, naming the agent', () => {
  assert.deepEqual(stopQuestion({ id: 'a', queue: [] }, 'Claude'), { text: 'Stop Claude?', ok: 'Stop' });
});

test('Stop on a subagent asks too, and says its lead gets no report', () => {
  const q = stopQuestion({ id: 'c', parentId: 'a' }, 'Codex');
  assert.equal(q.ok, 'Stop subagent');
  assert.match(q.text, /^Stop this subagent\?\n\n/);
  assert.match(q.text, /no report/);
});

test('a lead says its running subagents stop with it, and queued follow-ups stay', () => {
  const q = stopQuestion({ id: 'a', queue: [{}] }, 'Claude', 2);
  assert.match(q.text, /Its 2 subagents stop too\./);
  assert.match(q.text, /queued follow-up stays, held/);
  const one = stopQuestion({ id: 'a', queued: 2 }, 'Claude', 1);
  assert.match(one.text, /Its subagent stops too\./);
  assert.match(one.text, /follow-ups stay/);
});
