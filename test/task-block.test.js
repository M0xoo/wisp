// The task block: the agent points at another wisp task by id. The server keeps the task's title in
// the block; the page opens the task with a click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers.js';

process.env.WISP_HOME = tmp('task-home');
const { Store } = await import('../server/store.js');
const { blocksToMarkdown } = await import('../server/render.js');
const { SYSTEM_PROMPT } = await import('../server/protocol.js');
const { BUILTIN_BLOCKS, PARTS } = await import('../web/js/spell-schema.js');

const session = (id, title, blocks = []) => ({ id, cwd: tmp('task-proj'), agent: 'claude', state: 'done', title, turns: [{ id: 't1', presentation: { blocks } }], queue: [] });

test('the agent is told about the task block', () => {
  assert.match(SYSTEM_PROMPT, /"type":"task","id"/);
});

test('task is a built-in block that spells can restyle', () => {
  assert.ok(BUILTIN_BLOCKS.includes('task'));
  assert.equal(PARTS.task, '.b-task');
  assert.ok(PARTS['task.open']);
});

test('keepTasks keeps the named task title, and leaves unknown or titled blocks alone', () => {
  const store = new Store();
  store.put(session('leads1', 'Drafted 3 posts'));
  const s = session('me1', 'Find it', [{ type: 'task', id: ' leads1 ' }, { type: 'task', id: 'gone' }, { type: 'task', id: 'leads1', title: 'Given' }, { type: 'task' }]);
  assert.equal(store.keepTasks(s.turns[0]), true);
  const [kept, gone, given, bare] = s.turns[0].presentation.blocks;
  assert.equal(kept.title, 'Drafted 3 posts');
  assert.equal(gone.title, undefined);
  assert.equal(given.title, 'Given');
  assert.equal(bare.title, undefined);
  assert.equal(store.keepTasks(s.turns[0]), false);
  store.delete('leads1');
});

test('the markdown export names the task and its id', () => {
  const out = blocksToMarkdown([{ type: 'task', id: 'abc123', title: 'Leads list', note: 'request 37' }]);
  assert.match(out, /Leads list/);
  assert.match(out, /abc123/);
  assert.match(out, /request 37/);
});
