// The task block (v1 test/task-block.test.js, its pure parts): the agent points at another wisp task
// by id. v1's "keepTasks keeps the named task title" needs the store and moves with the runner's
// finish tests; "task is a built-in block that spells can restyle" checks kit parts (the UI port).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../src/blocks/prompt.ts';
import { blocksToMarkdown } from '../src/blocks/render.ts';
import { BUILTIN_BLOCKS } from '../src/blocks/check.ts';

test('the agent is told about the task block, and it is a built-in type', () => {
  assert.match(SYSTEM_PROMPT, /"type":"task","id"/);
  assert.ok(BUILTIN_BLOCKS.has('task'));
});

test('the markdown export names the task and its id', () => {
  const out = blocksToMarkdown([{ type: 'task', id: 'abc123', title: 'Leads list', note: 'request 37' }]);
  assert.match(out, /Leads list/);
  assert.match(out, /abc123/);
  assert.match(out, /request 37/);
  assert.equal(blocksToMarkdown([{ type: 'task', id: 'x' }]), '🔗 **A wisp task** (wisp task `x`)');
});
