// The protocol prompt: the rules for picking blocks, which each save the user a follow-up they
// kept typing (ship it, show me, did you…?, conflicts, which ones, too long, too many warnings).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, SYSTEM_PROMPT } from '../server/protocol.js';

const section = (p) => p.slice(p.indexOf('### Picking blocks'), p.indexOf('### Blocks'));

test('the protocol says which block to reach for, before the block list', () => {
  const s = section(SYSTEM_PROMPT);
  assert.ok(SYSTEM_PROMPT.indexOf('### Picking blocks') > 0);
  assert.ok(s.length > 0, 'comes before ### Blocks');
  assert.match(s, /"actions" block whose first item is the next\s+ship step/);
  assert.match(s, /Changed UI[\s\S]*"image"[\s\S]*"preview"[\s\S]*not done/);
  assert.match(s, /"checklist" with every stage/);
  assert.match(s, /`git merge-tree --write-tree\s+<base> HEAD`/);
  assert.match(s, /"graph" with "merge":"conflict"/);
  assert.match(s, /An "app"\s+with a checkbox per finding when it's offered, otherwise a "question"/);
  assert.match(s, /show it with "doc"/);
  assert.match(s, /"callout" is for what the user must act on[\s\S]*One or two at most/);
});

test('the block docs repeat the rules where agents look them up', () => {
  assert.match(SYSTEM_PROMPT, /Every UI change gets one/);
  assert.match(SYSTEM_PROMPT, /"type":"checklist"[^\n]*\n {2}Where a ship, release or deploy stands/);
  assert.match(SYSTEM_PROMPT, /the first item is the next ship step/);
  assert.match(SYSTEM_PROMPT, /the most likely next request first/);
  assert.match(SYSTEM_PROMPT, /Rare: if every answer has one/);
});

test('the example answer follows the rules and is valid JSON', () => {
  const m = SYSTEM_PROMPT.match(/```wisp\n([\s\S]*?)\n```/);
  const { blocks } = JSON.parse(m[1]);
  const types = blocks.map((b) => b.type);
  assert.equal(types[0], 'hero');
  assert.ok(types.indexOf('actions') > types.indexOf('tests'), 'a ship action after the evidence');
  assert.ok(blocks.find((b) => b.type === 'actions').items[0].reply);
  assert.ok(types.filter((t) => t === 'callout').length <= 1);
});

test('the rules stay in every variant of the prompt', () => {
  for (const p of [systemPrompt({ askTool: null }), systemPrompt({ ask: '- Nobody to ask.' }), systemPrompt({ apps: true })]) {
    assert.match(section(p), /Changed code the user still has to ship/);
  }
  assert.ok(systemPrompt({ apps: true }).indexOf('"type":"app"') > systemPrompt({ apps: true }).indexOf('### Picking blocks'));
});
