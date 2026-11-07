// Presentation → markdown (v1 server/render.js): the CLI, MCP, webhooks, chat apps and a lead
// reading its delegates' reports all read this. It never throws, and a block it can't render costs
// only that block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, sessionToMarkdown } from '../src/blocks/render.ts';
import { countChanges, diffLines, hunks } from '../src/blocks/diff.ts';
import type { Session, Turn } from '../src/model.ts';

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 't1', prompt: 'p', agent: 'claude', model: '', effort: '', mode: 'auto', attachments: [], startedAt: 1, endedAt: 2,
  status: 'done', activity: [], changes: [], presentation: null, stats: null, ...over,
});
const session = (turns: Turn[], over: Partial<Session> = {}): Session => ({
  id: 's1', title: 't', agent: 'claude', cwd: '/p', mode: 'auto', model: '', effort: '', state: 'review', unread: false,
  createdAt: 1, updatedAt: 1, agentSessionId: null, agentSessions: {}, queue: [], turns, ext: {}, ...over,
});

test('a diff block without its own snippet shows the captured edits of that file, by suffix too', () => {
  const t = turn({ changes: [{ file: 'src/a.ts', op: 'edit', edits: [{ before: 'a\nb\nc', after: 'a\nB\nc' }] }] });
  for (const file of ['src/a.ts', 'a.ts']) {
    assert.equal(blocksToMarkdown([{ type: 'diff', file }], t), `**\`${file}\`**\n\n\`\`\`diff\n a\n-b\n+B\n c\n\`\`\``);
  }
  assert.equal(blocksToMarkdown([{ type: 'diff', file: 'other.ts' }], t), '**`other.ts`** _(no captured edits)_');
  assert.equal(blocksToMarkdown([{ type: 'diff', file: 'x' }]), '**`x`** _(no captured edits)_', 'no turn: nothing captured');
});

test('long unchanged runs collapse to a count, and several edits are separated', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l10', 'L10');
  const md = blocksToMarkdown([{ type: 'diff', file: 'f', before, after }, { type: 'markdown', text: 'end' }]);
  assert.match(md, /@@ 7 unchanged lines @@\n l7\n l8\n l9\n-l10\n\+L10\n l11/);
  assert.match(md, /l13\n@@ 6 unchanged lines @@/);
  const two = turn({ changes: [{ file: 'f', op: 'edit', edits: [{ before: 'a', after: 'b' }, { before: '', after: 'c' }] }] });
  assert.match(blocksToMarkdown([{ type: 'diff', file: 'f' }], two), /-a\n\+b\n@@ … @@\n\+c/);
});

test('a fence grows past the backticks inside it', () => {
  assert.equal(blocksToMarkdown([{ type: 'code', code: 'a ``` b' }]), '````\na ``` b\n````');
});

test('a block that can not render costs only itself; unknown types show as JSON', () => {
  const md = blocksToMarkdown([{ type: 'files', items: [null] }, { type: 'hero', title: 'Kept' }, { type: 'mystery', n: 1 }]);
  assert.equal(md, '## Kept\n\n**✅ Done**\n\n```json\n{\n  "type": "mystery",\n  "n": 1\n}\n```');
  assert.equal(blocksToMarkdown('not a list'), '');
  assert.equal(blocksToMarkdown([null]), '```json\nnull\n```');
});

test('a contributed block type renders through its summary template', () => {
  const extra = (type: string) => (type === 'deploy' ? { summary: '🚀 {target} at {where.url}' } : null);
  assert.equal(blocksToMarkdown([{ type: 'deploy', target: 'prod', where: { url: 'https://x.dev' } }], null, extra), '🚀 prod at https://x.dev');
  // inside an app's fallback too
  assert.match(blocksToMarkdown([{ type: 'app', title: 'A', fallback: [{ type: 'deploy', target: 'p' }] }], null, extra), /_\(interactive: open it in wisp\)_\n\n🚀 p at $/);
});

test('an app shows its fallback, never another app', () => {
  assert.equal(blocksToMarkdown([{ type: 'app', fallback: [{ type: 'app' }, { type: 'next', items: ['x'] }] }]), '**🧩 Interactive** _(interactive: open it in wisp)_\n\n**Next**\n- x');
  assert.equal(blocksToMarkdown([{ type: 'app', title: 'T' }]), '**🧩 T** _(interactive: open it in wisp)_');
});

test('blocked items say whether the user allowed them', () => {
  const md = blocksToMarkdown([{ type: 'blocked', items: [{ tool: 'shell', detail: 'npm publish', why: 'network' }] }], turn({ approval: 'allowed' }));
  assert.equal(md, '**🔒 Blocked by permissions** _(allowed)_\n- shell: `npm publish` — network');
});

test('flow edges default to the nodes in order', () => {
  assert.equal(blocksToMarkdown([{ type: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b' }, { id: 'c', label: 'C' }] }]), '- A → b\n- b → C');
});

test('spell blocks say what keeping them does', () => {
  assert.equal(blocksToMarkdown([{ type: 'spell', remove: 'old' }]), '**🧙 Spell:** remove `old`');
  assert.equal(blocksToMarkdown([{ type: 'spell', spell: { name: 'S', description: 'd' } }]), '**🧙 Spell: S** — d\n\n_Keep it in wisp to turn it on._');
});

test('a session: the last answer, a running turn says what it is doing, and an open question', () => {
  const running = turn({ status: 'running', activity: [{ t: 1, kind: 'read', label: 'Read a.ts' }, { t: 2, kind: 'text', label: 'thinking out loud' }] });
  assert.equal(sessionToMarkdown(session([running]), ['_never while running_']), '_Working… (Read a.ts)_');
  assert.equal(sessionToMarkdown(session([turn({ status: 'running' })])), '_Working… (starting up)_');
  const done = turn({ presentation: { blocks: [{ type: 'hero', title: 'Done it', status: 'done' }] } });
  const ask = { id: 'a', question: 'Allow npm publish?', context: 'needs a token', options: ['Allow', 'Deny'], askedAt: 1, permission: { tool: 'Bash', action: 'run npm publish', detail: 'npm publish' } };
  assert.equal(
    sessionToMarkdown(session([done], { ask }), ['_Changes are on branch `b`._']),
    '## Done it\n\n**✅ Done**\n\n**🔒 The agent needs your approval:** Allow npm publish?\n\nneeds a token\n\n1. Allow\n2. Deny\n\n_Changes are on branch `b`._',
  );
  assert.equal(sessionToMarkdown(session([])), '');
});

test('diffLines is an LCS line diff with line numbers; countChanges counts both sides', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nc'), [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: '-', text: 'b', a: 2 },
    { op: '+', text: 'c', b: 2 },
  ]);
  assert.deepEqual(diffLines('', 'x'), [{ op: '+', text: 'x', b: 1 }]);
  assert.deepEqual(hunks(diffLines('a', 'a')), [], 'nothing changed, nothing shown');
  assert.deepEqual(countChanges([{ before: 'a\nb\nc', after: 'a\nc\nd\ne' }, { after: 'new' }]), { add: 3, del: 1 });
});
