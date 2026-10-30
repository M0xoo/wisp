// The protocol prompt: the rules for picking blocks, which each save the user a follow-up they
// kept typing (ship it, show me, did you…?, conflicts, which ones, too long, too many warnings).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, SYSTEM_PROMPT, blockDocs, parsePresentation } from '../server/protocol.js';

const section = (p) => p.slice(p.indexOf('### Picking blocks'), p.indexOf('### Blocks'));

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

test('long block docs are read on demand where wisp\'s tools are, and in full where they are not', () => {
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

test('wisp_blocks answers from wisp\'s MCP server without calling wisp', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../server/mcp-ask.js', import.meta.url))], { env: { ...process.env, WISP_URL: 'http://127.0.0.1:1', WISP_TOKEN: 't', WISP_SESSION: 's' } });
  const replies = [];
  let buf = '';
  srv.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (buf.slice(0, i).trim()) replies.push(JSON.parse(buf.slice(0, i)));
  });
  const send = (id, method, params) => srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(1, 'tools/list', {});
  send(2, 'tools/call', { name: 'wisp_blocks', arguments: { types: ['graph'] } });
  for (let i = 0; replies.length < 2 && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
  srv.kill();
  assert.ok(replies.find((r) => r.id === 1).result.tools.some((t) => t.name === 'wisp_blocks'));
  assert.match(replies.find((r) => r.id === 2).result.content[0].text, /"type":"graph","title"/);
});

test('a quick answer may be plain text: the agent does not wrap "13" in a report', () => {
  assert.match(SYSTEM_PROMPT, /A quick answer with nothing to show[^]*is plain text with no wisp block/);
  // wisp shows it as it is: plain text parses as markdown.
  const { blocks } = parsePresentation('13');
  assert.equal(blocks[0].type, 'markdown');
  assert.equal(blocks[0].text, '13');
});
