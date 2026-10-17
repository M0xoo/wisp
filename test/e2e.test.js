// The whole loop through a real wisp server: launch over HTTP → the agent calls the injected
// ask_user MCP server (server/mcp-ask.js) → the session waits → answer over HTTP → the agent
// resumes and finishes → presentation, diffs and follow-ups land in the session record.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('e2e-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('e2e-home');
process.env.WISP_UPDATE_CHECK = '0'; // no registry calls from tests
installFakeBins();

const { startServer } = await import('../server/index.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function api(p, body) {
  const r = await fetch(`${base}/api${p}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const session = (id) => api(`/sessions/${id}`);

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('every fake harness is detected through /api/agents', async () => {
  const agents = await api('/agents');
  assert.deepEqual(agents.map((a) => [a.id, a.available]), [['claude', true], ['codex', true], ['opencode', true], ['cursor', true], ['antigravity', true]]);
});

test('/api/update reports the current version; a git checkout refuses to self-update', async () => {
  const u = await api('/update');
  assert.equal(u.current, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(u.available, false);
  assert.equal(u.method, 'git');
  assert.equal(u.auto, false);
  const r = await fetch(`${base}/api/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
});

for (const agent of ['claude', 'codex', 'opencode']) {
  test(`${agent}: ask_user round trip, then a follow-up resumes the same agent session`, async () => {
    const cwd = makeRepo();
    const s = await api('/sessions', { prompt: 'ASK before fixing add()', cwd, agent, mode: 'edits' });

    // The agent is blocked inside the MCP tool call until we answer.
    const waiting = await until(async () => {
      const x = await session(s.id);
      return x.state === 'waiting' && x;
    });
    assert.equal(waiting.ask.question, 'Proceed with the fix?');
    assert.deepEqual(waiting.ask.options, ['Yes', 'No']);
    await api(`/sessions/${s.id}/answer`, { text: 'Yes, go ahead' });

    const done = await until(async () => {
      const x = await session(s.id);
      return x.state === 'review' && x;
    });
    const turn = done.turns.at(-1);
    assert.equal(turn.status, 'done');
    const hero = turn.presentation.blocks[0];
    assert.equal(hero.type, 'hero');
    assert.equal(hero.title, `Fake ${agent === 'opencode' || agent === 'codex' ? agent : 'claude'} finished`);
    assert.match(hero.summary, /The user answered: Yes, go ahead/);
    assert.ok(turn.changes.some((c) => c.file === 'math.js'), 'diff recorded');
    assert.ok(turn.activity.some((a) => a.kind === 'answer'), 'answer shown in the trail');
    assert.equal(done.agentSessionId, `${agent}-session-1`);

    // Follow-up: same agent session, no protocol re-sent.
    await api(`/sessions/${s.id}/reply`, { text: 'now add a test' });
    const again = await until(async () => {
      const x = await session(s.id);
      return x.turns.length === 2 && x.state === 'review' && x;
    });
    assert.equal(again.turns.at(-1).status, 'done');
    const last = records(RECORD, agent).at(-1);
    assert.ok(last.argv.includes(`${agent}-session-1`), 'resumed by id');
  });
}

test('cursor: runs without ask_user and still lands a presentation', async () => {
  const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'cursor', mode: 'auto' });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.state === 'review' && x;
  });
  assert.equal(done.turns[0].status, 'done');
  assert.equal(done.turns[0].presentation.blocks[0].title, 'Fake cursor-agent finished');
  const change = done.turns[0].changes.find((c) => c.file === 'math.js');
  assert.match(change.edits[0].before, /a - b/);
  assert.ok(records(RECORD, 'cursor-agent').at(-1).argv.includes('--force'), 'auto mode');
});

test('antigravity: runs without ask_user and still lands a presentation', async () => {
  const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'antigravity', mode: 'auto' });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.state === 'review' && x;
  });
  assert.equal(done.turns[0].status, 'done');
  assert.equal(done.turns[0].presentation.blocks[0].title, 'Fake agy finished');
  const change = done.turns[0].changes.find((c) => c.file === 'math.js');
  assert.match(change.edits[0].before, /a - b/);
  assert.ok(records(RECORD, 'agy').at(-1).argv.includes('--dangerously-skip-permissions'), 'auto mode');
});

test('stopping a running session marks the turn stopped', async () => {
  process.env.FAKE_HANG = '1';
  try {
    const s = await api('/sessions', { prompt: 'long task', cwd: makeRepo(), agent: 'codex' });
    await until(async () => (await session(s.id)).turns[0].activity.length > 0);
    await api(`/sessions/${s.id}/stop`, {});
    const done = await until(async () => {
      const x = await session(s.id);
      return x.turns[0].status !== 'running' && x;
    });
    assert.equal(done.turns[0].status, 'stopped');
  } finally {
    delete process.env.FAKE_HANG;
  }
});
