// The doc block: a markdown file the agent wrote, kept in the turn as it was, and shown in the
// file manager on request (POST /sessions/:id/reveal).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, tmp } from './helpers.js';

process.env.WISP_HOME = tmp('doc-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();
const { startServer } = await import('../server/index.js');
const { blocksToMarkdown } = await import('../server/render.js');
const { SYSTEM_PROMPT } = await import('../server/protocol.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
before(async () => {
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

const project = () => {
  const dir = tmp('doc-proj');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/plan.md'), '# Plan\n\n- one\n- two\n');
  return dir;
};
const session = (cwd, blocks) => ({ id: `doc${Math.random().toString(36).slice(2, 10)}`, cwd, agent: 'claude', state: 'review', title: 't', turns: [{ id: 't1', presentation: { blocks } }], queue: [] });

const reveal = (id, p) => fetch(`${base}/api/sessions/${id}/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });

test('the agent is told about the doc block', () => {
  assert.match(SYSTEM_PROMPT, /"type":"doc","path"/);
});

test('keepDocs snapshots the file into the block', () => {
  const dir = project();
  const s = session(dir, [{ type: 'doc', path: 'docs/plan.md' }, { type: 'doc', path: 'docs/gone.md' }, { type: 'doc', path: 'x.md', text: 'given' }]);
  assert.equal(srv.store.keepDocs(s, s.turns[0]), true);
  const [kept, gone, given] = s.turns[0].presentation.blocks;
  assert.equal(kept.text, '# Plan\n\n- one\n- two\n');
  assert.equal(kept.abs, path.join(dir, 'docs/plan.md'));
  assert.equal(gone.text, undefined);
  assert.equal(given.text, 'given');
  // Already kept: nothing to do the second time.
  assert.equal(srv.store.keepDocs(s, s.turns[0]), false);
});

test('reveal shows files in the project or named by a block, nothing else', async () => {
  const dir = project();
  const outside = path.join(tmp('doc-out'), 'report.md');
  fs.writeFileSync(outside, '# Report');
  const s = session(dir, [{ type: 'doc', path: outside }]);
  srv.store.put(s);
  let r = await reveal(s.id, 'docs/plan.md');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).path, path.join(dir, 'docs/plan.md'));
  assert.equal((await reveal(s.id, outside)).status, 200);
  assert.equal((await reveal(s.id, 'docs/missing.md')).status, 404);
  r = await reveal(s.id, '/etc/hosts');
  assert.equal(r.status, 404);
  assert.equal((await reveal(s.id, '')).status, 404);
  srv.store.delete(s.id);
});

test('the markdown export names the file and folds its text', () => {
  const out = blocksToMarkdown([{ type: 'doc', path: 'docs/plan.md', title: 'Plan', text: '# Plan\n\nBody' }]);
  assert.match(out, /docs\/plan\.md/);
  assert.match(out, /<details>/);
  assert.match(out, /Body/);
});
