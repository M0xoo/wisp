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
  assert.deepEqual(agents.map((a) => [a.id, a.available]), [['claude', true], ['codex', true], ['opencode', true], ['cursor', true], ['antigravity', true], ['grok', true]]);
});

test('re-check finds models added after wisp cached the detection', async () => {
  const ids = (agents) => agents.find((a) => a.id === 'opencode').models.map((m) => m.id);
  assert.deepEqual(ids(await api('/agents')), ['', 'fake/model-a', 'fake/model-b']);
  process.env.FAKE_OPENCODE_EXTRA = 'other/model-c';
  try {
    assert.deepEqual(ids(await api('/agents')), ['', 'fake/model-a', 'fake/model-b'], 'a hit stays cached');
    assert.deepEqual(ids(await api('/agents/recheck', {})), ['', 'fake/model-a', 'fake/model-b', 'other/model-c']);
    assert.deepEqual(ids(await api('/agents')), ['', 'fake/model-a', 'fake/model-b', 'other/model-c']);
  } finally {
    delete process.env.FAKE_OPENCODE_EXTRA;
    await api('/agents?fresh=1');
  }
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

for (const agent of ['claude', 'codex', 'opencode', 'grok']) {
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
    assert.equal(hero.title, `Fake ${agent} finished`);
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

test('wisp_stats: an agent reads tool counts across the user\'s sessions through the injected MCP server', async () => {
  // Earlier tests left finished claude turns with Read / Edit / Bash calls in the store.
  const s = await api('/sessions', { prompt: 'STATS: which tools do my tasks use?', cwd: makeRepo(), agent: 'claude', mode: 'edits', worktree: false });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.state === 'review' && x;
  });
  const summary = done.turns.at(-1).presentation.blocks[0].summary;
  assert.match(summary, /wisp tool stats — last 7 days \(harness claude\)/);
  const [, calls, turns] = summary.match(/(\d+) tool calls in (\d+) turns/);
  assert.ok(Number(turns) >= 1 && Number(calls) >= 3 * Number(turns), summary);

  // The bridge refuses calls without the run's token.
  const r = await fetch(`${base}/api/internal/stats/${s.id}`);
  assert.equal(r.status, 403);
});

test('a follow-up can switch harness and model: the new harness gets the turns it missed, switching back resumes', async () => {
  const s = await api('/sessions', { prompt: 'look at add() please', cwd: makeRepo(), agent: 'claude', mode: 'edits', worktree: false });
  const turns = (n) => until(async () => {
    const x = await session(s.id);
    return x.turns.length === n && x.state === 'review' && x;
  });
  const last = (bin) => records(RECORD, bin).at(-1);
  await turns(1);

  // Same harness, another model and level: the same conversation, resumed.
  await api(`/sessions/${s.id}/reply`, { text: 'try a bigger model', model: 'opus', effort: 'high' });
  let x = await turns(2);
  assert.ok(last('claude').argv.includes('--resume') && last('claude').argv.includes('claude-session-1'), 'resumed');
  assert.deepEqual([x.model, x.effort], ['opus', 'high']);
  assert.doesNotMatch(last('claude').stdin, /Earlier in this task/);

  // Another harness: a fresh conversation there, handed both earlier turns.
  await api(`/sessions/${s.id}/reply`, { text: 'codex, take it from here', agent: 'codex' });
  x = await turns(3);
  const codex = last('codex');
  assert.ok(!codex.argv.includes('resume'), 'nothing of its own to resume');
  assert.match(codex.stdin, /## Earlier in this task/);
  assert.match(codex.stdin, /taking over a task that another coding agent \(Claude Code\)/);
  assert.match(codex.stdin, /look at add\(\) please/);
  assert.match(codex.stdin, /try a bigger model/);
  assert.match(codex.stdin, /Fake claude finished/);
  assert.match(codex.stdin, /## Follow-up\n\ncodex, take it from here/);
  assert.equal(x.agent, 'codex');
  assert.deepEqual([x.model, x.effort], ['', ''], 'a new harness starts on its default');
  assert.equal(x.agentSessionId, 'codex-session-1');
  assert.deepEqual(x.agentSessions, { claude: 'claude-session-1', codex: 'codex-session-1' });
  assert.deepEqual(x.turns.map((t) => [t.agent, t.model]), [['claude', ''], ['claude', 'opus'], ['codex', '']]);
  assert.equal(x.turns.at(-1).prompt, 'codex, take it from here', 'the turn keeps what the user typed');

  // Back to Claude: its own conversation resumes, told only about the codex turn.
  await api(`/sessions/${s.id}/reply`, { text: 'back to you, claude', agent: 'claude', model: 'opus' });
  x = await turns(4);
  const claude = last('claude');
  assert.ok(claude.argv.includes('claude-session-1'), 'resumed its own session');
  assert.match(claude.stdin, /While you were away, this task continued on another coding agent \(Codex\)/);
  assert.match(claude.stdin, /codex, take it from here/);
  assert.doesNotMatch(claude.stdin, /look at add\(\) please/, 'it already saw its own turns');
  assert.equal(x.agentSessionId, 'claude-session-1');

  // No switch: no handoff.
  await api(`/sessions/${s.id}/reply`, { text: 'one more thing' });
  await turns(5);
  assert.doesNotMatch(last('claude').stdin, /Earlier in this task/);

  // Queued with a switch: the run going keeps its harness; the queued one moves.
  process.env.FAKE_HANG = '1';
  try {
    await api(`/sessions/${s.id}/reply`, { text: 'long one' });
    await until(async () => (await session(s.id)).turns[5]?.activity.length > 0);
    const r = await api(`/sessions/${s.id}/reply`, { text: 'then opencode', agent: 'opencode', queue: true });
    assert.equal(r.queued, true);
    assert.equal((await session(s.id)).agent, 'claude');
  } finally {
    delete process.env.FAKE_HANG;
  }
  // Interrupt: this one goes ahead on claude, then the queued one runs on opencode.
  await api(`/sessions/${s.id}/reply`, { text: 'actually, first this' });
  x = await turns(8);
  assert.deepEqual(x.turns.slice(5).map((t) => t.agent), ['claude', 'claude', 'opencode']);
  assert.equal(x.agent, 'opencode');
  assert.match(last('opencode').stdin, /Claude Code, Codex|Codex, Claude Code/);

  const reply = (body) => fetch(`${base}/api/sessions/${s.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', ...body }) });
  assert.equal((await reply({ agent: 'nope' })).status, 400);
});

test('a follow-up can switch the mode: plan → edits → auto, and a queued one keeps its own', async () => {
  const s = await api('/sessions', { prompt: 'look at add()', cwd: makeRepo(), agent: 'claude', mode: 'plan', worktree: false });
  const turns = (n) => until(async () => {
    const x = await session(s.id);
    return x.turns.length === n && x.state === 'review' && x;
  });
  const permission = () => {
    const argv = records(RECORD, 'claude').at(-1).argv;
    return argv[argv.indexOf('--permission-mode') + 1];
  };
  await turns(1);
  assert.equal(permission(), 'plan');

  await api(`/sessions/${s.id}/reply`, { text: 'go ahead and fix it', mode: 'edits' });
  let x = await turns(2);
  assert.equal(permission(), 'acceptEdits');
  assert.equal(x.mode, 'edits');
  assert.deepEqual(x.turns.map((t) => t.mode), ['plan', 'edits']);

  // No mode: the follow-up stays in the session's current one.
  await api(`/sessions/${s.id}/reply`, { text: 'and once more' });
  x = await turns(3);
  assert.equal(permission(), 'acceptEdits');

  // Queued while running: the run already going keeps its mode; the queued one switches.
  process.env.FAKE_HANG = '1';
  try {
    await api(`/sessions/${s.id}/reply`, { text: 'long one' });
    await until(async () => (await session(s.id)).turns[3]?.activity.length > 0);
    const r = await api(`/sessions/${s.id}/reply`, { text: 'then run it all', mode: 'auto', queue: true });
    assert.equal(r.queued, true);
    assert.equal((await session(s.id)).mode, 'edits');
  } finally {
    delete process.env.FAKE_HANG;
  }
  // Interrupt: this one goes ahead of the queued one, still in edits; then the queued one runs in auto.
  await api(`/sessions/${s.id}/reply`, { text: 'actually, first this' });
  x = await turns(6);
  assert.deepEqual(x.turns.map((t) => t.mode), ['plan', 'edits', 'edits', 'edits', 'edits', 'auto']);
  assert.equal(x.mode, 'auto');
  assert.equal(permission(), 'bypassPermissions');
  const bad = await fetch(`${base}/api/sessions/${s.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', mode: 'yolo' }) });
  assert.equal(bad.status, 400);
});

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

// The CLI ends its turn ("I'll report once it has finished") with a background task still running,
// then reports again when it finishes. Killing it after the first result killed the task too.
test('claude: a turn waits on its background tasks and lands the report that follows', async () => {
  process.env.FAKE_BACKGROUND = '4500'; // longer than the 3 s linger that used to kill it
  try {
    const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
    await until(async () => (await session(s.id)).turns[0].activity.some((a) => a.kind === 'background'));
    const waiting = await session(s.id);
    assert.equal(waiting.turns[0].status, 'running');
    assert.equal(waiting.state, 'running');
    const card = (await api('/sessions')).find((x) => x.id === s.id);
    assert.equal(card.live, 'Waiting on background task: Run the full test suite');
    const done = await until(async () => {
      const x = await session(s.id);
      return x.turns[0].status !== 'running' && x;
    });
    assert.equal(done.turns[0].status, 'done');
    assert.equal(done.turns[0].presentation.blocks[0].title, 'Fake claude finished');
    assert.match(done.turns[0].presentation.blocks[0].summary, /background done/);
    assert.ok(done.turns[0].activity.some((a) => a.label === 'Background work finished, wrapping up'));
    assert.equal(done.turns[0].interim, undefined);
  } finally {
    delete process.env.FAKE_BACKGROUND;
  }
});

test('claude: a CLI that exits while waiting on background work keeps its last report', async () => {
  process.env.FAKE_BACKGROUND = 'exit';
  try {
    const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
    const done = await until(async () => {
      const x = await session(s.id);
      return x.turns[0].status !== 'running' && x;
    });
    assert.equal(done.turns[0].status, 'done');
    assert.match(JSON.stringify(done.turns[0].presentation), /report once it has finished/);
  } finally {
    delete process.env.FAKE_BACKGROUND;
  }
});

test('claude: a full presentation with a background task still up (a dev server) ends the turn', async () => {
  process.env.FAKE_BACKGROUND = 'hang';
  process.env.FAKE_BACKGROUND_DONE = '1';
  try {
    const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
    const done = await until(async () => {
      const x = await session(s.id);
      return x.turns[0].status !== 'running' && x;
    });
    assert.equal(done.turns[0].status, 'done');
    assert.match(done.turns[0].presentation.blocks[0].summary, /dev server left running/);
    assert.ok(!done.turns[0].activity.some((a) => a.kind === 'background'));
  } finally {
    delete process.env.FAKE_BACKGROUND;
    delete process.env.FAKE_BACKGROUND_DONE;
  }
});

test('claude: stopping a turn that waits on background work marks it stopped', async () => {
  process.env.FAKE_BACKGROUND = 'hang';
  try {
    const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
    await until(async () => (await session(s.id)).turns[0].activity.some((a) => a.kind === 'background'));
    await api(`/sessions/${s.id}/stop`, {});
    const done = await until(async () => {
      const x = await session(s.id);
      return x.turns[0].status !== 'running' && x;
    });
    assert.equal(done.turns[0].status, 'stopped');
  } finally {
    delete process.env.FAKE_BACKGROUND;
  }
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
