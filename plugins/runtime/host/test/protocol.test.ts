// The protocol prompt (v1 test/protocol.test.js): the rules for picking blocks, which each save the
// user a follow-up they kept typing (ship it, show me, did you…?, conflicts, which ones, too long).
// v1's three MCP-server tests (wisp_blocks over MCP, plan-mode read-only hints, two ask_user calls
// in a row) test server/mcp-ask.js, which wisp.mcp owns: they move with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, blockDocs, systemPrompt } from '../src/blocks/prompt.ts';
import { heroOf, jsonEnd, parsePresentation } from '../src/blocks/parse.ts';

const section = (p: string): string => p.slice(p.indexOf('### Picking blocks'), p.indexOf('### Blocks'));

test('the protocol says which block to reach for, before the block list', () => {
  const s = section(SYSTEM_PROMPT);
  assert.ok(SYSTEM_PROMPT.indexOf('### Picking blocks') > 0);
  assert.ok(s.length > 0, 'comes before ### Blocks');
  assert.match(s, /"actions" block whose first item is the next\s+ship step/);
  assert.match(s, /new feature[\s\S]*"preview"[\s\S]*"image"[\s\S]*not done/);
  assert.match(s, /"checklist" with every stage/);
  assert.match(s, /`git merge-tree --write-tree\s+<base> HEAD`/);
  assert.match(s, /"graph" with "merge":"conflict"/);
  assert.match(s, /An "app"\s+with a checkbox per finding when it's offered, otherwise a "question"/);
  assert.match(s, /show it with "doc"/);
  assert.match(s, /"callout" is for what the user must act on[\s\S]*One or two at most/);
});

test('the block docs repeat the rules where agents look them up', () => {
  assert.match(SYSTEM_PROMPT, /Every UI change gets one/);
  assert.match(SYSTEM_PROMPT, /"type":"preview"[^\n]*\n[\s\S]*?best evidence for a new feature/);
  assert.match(SYSTEM_PROMPT, /"type":"checklist"[^\n]*\n {2}Where a ship, release or deploy stands/);
  assert.match(SYSTEM_PROMPT, /the first item is the next ship step/);
  assert.match(SYSTEM_PROMPT, /the most likely next request first/);
  assert.match(SYSTEM_PROMPT, /Rare: if every answer has one/);
});

test('wisp blocks off: a plain markdown answer, with no block anywhere in the prompt', () => {
  for (const p of [systemPrompt({ blocks: false }), systemPrompt({ askTool: null, blocks: false }), systemPrompt({ blocks: false, apps: true, extraBlocks: [{ type: 'x', doc: 'x', spell: 's' }] })]) {
    assert.match(p, /## Your final message\n\nEnd with a short answer in plain markdown, no `wisp` block/);
    assert.doesNotMatch(p.replace('no `wisp` block', ''), /```wisp|"type":|"(question|task|stuff)" block|### Blocks/);
    assert.match(p, /Verify your work/, 'the rest of the protocol stays');
  }
  assert.match(systemPrompt({ askTool: null, blocks: false }), /stop before acting on it and end by asking it, with 2–4 options/);
});

test('the example answer follows the rules and is valid JSON', () => {
  const m = SYSTEM_PROMPT.match(/```wisp\n([\s\S]*?)\n```/);
  assert.ok(m?.[1]);
  const { blocks } = JSON.parse(m[1]) as { blocks: { type: string; items?: { reply?: string }[] }[] };
  const types = blocks.map((b) => b.type);
  assert.equal(types[0], 'hero');
  assert.ok(types.indexOf('actions') > types.indexOf('tests'), 'a ship action after the evidence');
  assert.ok(blocks.find((b) => b.type === 'actions')?.items?.[0]?.reply);
  assert.ok(types.filter((t) => t === 'callout').length <= 1);
});

test('the rules stay in every variant of the prompt', () => {
  for (const p of [systemPrompt({ askTool: null }), systemPrompt({ ask: '- Nobody to ask.' }), systemPrompt({ apps: true })]) {
    assert.match(section(p), /Changed code the user still has to ship/);
  }
  assert.ok(systemPrompt({ apps: true }).indexOf('"type":"app"') > systemPrompt({ apps: true }).indexOf('### Picking blocks'));
});

test("long block docs are read on demand where wisp's tools are, and in full where they are not", () => {
  const withTools = systemPrompt({ askTool: 'mcp__wisp__ask_user', apps: true });
  assert.match(withTools, /- \{"type":"graph",…\} Branch graph[^\n]*`wisp_blocks` \(mcp__wisp__wisp_blocks\)/);
  assert.doesNotMatch(withTools, /"conflicts":\[/);
  // No tools to read them with: a harness without MCP, or a subagent.
  for (const p of [systemPrompt({ askTool: null }), systemPrompt({ ask: '- Nobody to ask.' })]) {
    assert.match(p, /"type":"graph","title"[\s\S]*"conflicts":\[/);
    assert.doesNotMatch(p, /wisp_blocks/);
  }
  assert.ok(withTools.length < systemPrompt({ askTool: null, apps: true }).length);
  // The tools' own descriptions carry stats, crew and connectors; the protocol keeps the key rule.
  assert.match(withTools, /Never ask the user to paste a key into the chat/);
  assert.doesNotMatch(withTools, /wisp_crew_kit/);

  assert.match(blockDocs(['graph']), /"merge":"conflict\|ready/);
  assert.match(blockDocs(['App', 'graph']), /wisp\.send[\s\S]*"type":"graph"/);
  assert.match(blockDocs(['hero']), /No long docs for "hero"/);
  assert.match(blockDocs('graph'), /"type":"graph"/, 'a bare string works too');
});

test('a quick answer may be plain text: the agent does not wrap "13" in a report', () => {
  assert.match(SYSTEM_PROMPT, /A quick answer with nothing to show[^]*is plain text: wisp shows it as it is/);
  const { blocks } = parsePresentation('13');
  assert.equal(blocks[0]?.type, 'markdown');
  assert.equal(blocks[0]?.['text'], '13');
});

test('a quick answer names its task with a wisp block that holds only a topic', () => {
  assert.match(SYSTEM_PROMPT, /one-line wisp block that only names the task[^]*\{"topic":"Title generator merge","blocks":\[\]\}/);
  // The text is the answer, as it is: no hero, no empty report, not a slip.
  const quick = parsePresentation('Not yet: #728 is open.\n```wisp\n{"topic":"  Title generator merge ","blocks":[]}\n```');
  assert.deepEqual(quick, { topic: 'Title generator merge', blocks: [{ type: 'markdown', text: 'Not yet: #728 is open.' }] });
  // No blocks key at all works too; with no text there's still something to show.
  assert.deepEqual(parsePresentation('```wisp\n{"topic":"X"}\n```'), { topic: 'X', blocks: [{ type: 'markdown', text: '_The agent finished without a message._' }] });
  // A full report may carry it at the top level as well.
  const full = parsePresentation('```wisp\n{"topic":"Login","blocks":[{"type":"hero","title":"Fixed"}]}\n```');
  assert.equal(full.topic, 'Login');
  assert.equal(full.blocks[0]?.type, 'hero');
  // An empty block with no topic (or a blank one) is still a slip, shown verbatim.
  for (const raw of ['{"blocks":[]}', '{"topic":" ","blocks":[]}']) assert.equal(parsePresentation('hi\n```wisp\n' + raw + '\n```').fallback, true);
});

// ---- the parser's forgiveness (v1 protocol.js readJson/salvageBlocks/closeBraces) ----

test('prose before the block is kept as notes; blocks without a string type are dropped', () => {
  const p = parsePresentation('Did it.\n```wisp\n{"blocks":[{"type":"hero","title":"A"},{"title":"no type"},null,{"type":7}]}\n```');
  assert.equal(p.notes, 'Did it.');
  assert.deepEqual(p.blocks, [{ type: 'hero', title: 'A' }]);
  assert.equal(p.fallback, undefined);
});

test('a bare array is a blocks list; the last parseable wisp block wins', () => {
  assert.deepEqual(parsePresentation('```wisp\n[{"type":"next","items":["x"]}]\n```').blocks, [{ type: 'next', items: ['x'] }]);
  const two = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":"Draft"}]}\n```\n```wisp\n{"blocks":[{"type":"hero","title":"Final"}]}\n```');
  assert.equal(heroOf(two)?.['title'], 'Final');
  const broken = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":"Good"}]}\n```\n```wisp\nnot json\n```');
  assert.equal(heroOf(broken)?.['title'], 'Good', 'a broken later block falls back to the earlier one');
});

test('``` inside a JSON string does not end the block', () => {
  const p = parsePresentation('```wisp\n{"blocks":[{"type":"markdown","text":"```sh\\nnpm test\\n```"}]}\n```');
  assert.equal(p.blocks[0]?.['text'], '```sh\nnpm test\n```');
});

test('trailing commas and smart quotes are forgiven', () => {
  const p = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":“Fixed”,"status":"done",},]}\n```');
  assert.deepEqual(p.blocks, [{ type: 'hero', title: 'Fixed', status: 'done' }]);
});

test('one malformed block costs only that block, with a note saying so', () => {
  const p = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":"Ran"},{"type":"terminal","output":"he said "hi""},{"type":"next","items":["Again"]}]}\n```');
  assert.deepEqual(p.blocks.map((b) => b.type), ['hero', 'next', 'callout']);
  assert.equal(p.blocks[2]?.['title'], '1 block skipped');
});

test('a last block missing its closing brace is closed; one that cannot be is counted as skipped', () => {
  const p = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":"Cut"},{"type":"stats","meta":{"n":1}\n```');
  assert.deepEqual(p.blocks, [{ type: 'hero', title: 'Cut' }, { type: 'stats', meta: { n: 1 } }]);
  // No `}` inside it to cut at: v1 gives up on it and says so.
  const q = parsePresentation('```wisp\n{"blocks":[{"type":"hero","title":"Cut"},{"type":"callout","text":"end"\n```');
  assert.deepEqual(q.blocks.map((b) => b.type), ['hero', 'callout']);
  assert.equal(q.blocks[1]?.['title'], '1 block skipped');
});

test('a payload nothing can save is shown verbatim in a fence, marked as a fallback', () => {
  const p = parsePresentation('Here.\n```wisp\n{"blocks": oops\n```');
  assert.equal(p.fallback, true);
  assert.equal(p.blocks[0]?.['text'], 'Here.\n\n`````json\n{"blocks": oops\n`````');
  assert.deepEqual(parsePresentation(''), { fallback: true, blocks: [{ type: 'markdown', text: '_The agent finished without a message._' }] });
});

test('jsonEnd matches brackets and respects strings and escapes', () => {
  assert.equal(jsonEnd('  {"a":"}\\"]"} tail'), 14);
  assert.equal(jsonEnd('[1,[2]]x'), 7);
  assert.equal(jsonEnd('{"open"'), -1);
  assert.equal(jsonEnd('text'), -1);
});
