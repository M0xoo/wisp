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
const { clipOutput } = await import('../server/runner.js');

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

test('claude: the transcript keeps whole messages, what calls printed, and which call made each edit', async () => {
  const s = await api('/sessions', { prompt: 'NARRATE then fix add()', cwd: makeRepo(), agent: 'claude', mode: 'auto', worktree: false });
  const done = await until(async () => {
    const x = await session(s.id);
    return x.state === 'review' && x;
  });
  const acts = done.turns[0].activity;
  const said = acts.find((a) => a.kind === 'text' && a.label.startsWith('Looking around first.'));
  assert.ok(said.label.length > 1000, 'a long message is kept whole');
  const status = acts.find((a) => a.kind === 'run' && a.detail === 'git status --short');
  assert.deepEqual([status.call, status.output], ['t4', ' M math.js']);
  assert.equal(acts.find((a) => a.kind === 'read').output, undefined, "a read's output is the file: not kept");
  assert.deepEqual(acts.find((a) => a.kind === 'edit').edits, [0, 1], 'the edit points at its slice of the change');
  assert.equal(acts.find((a) => a.kind === 'run' && a.detail === 'npm test').output, undefined, 'a failed call is an error row instead');
  assert.ok(acts.some((a) => a.kind === 'error'));
});

test('clipOutput keeps short output whole and long output as its first and last lines', () => {
  assert.equal(clipOutput('ok\n\n'), 'ok');
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const out = clipOutput(lines);
  assert.ok(out.length < 2100, `${out.length} chars`);
  assert.ok(out.startsWith('line 0\n') && out.endsWith('line 399'));
  assert.match(out, /\n… \d+ lines cut …\n/);
  assert.match(clipOutput('x'.repeat(5000)), /… 3100 characters cut …/);
});

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

test('a prompt that mentions another task: the agent reads it with wisp_session and finds it with wisp_sessions', async () => {
  const cwd = makeRepo();
  const a = await api('/sessions', { prompt: 'mention target: fix add()', cwd, agent: 'claude', mode: 'edits', worktree: false });
  await until(async () => (await session(a.id)).state === 'review');
  const b = await api('/sessions', { prompt: `Carry on from @[mention target: fix add()](wisp:${a.id}) please`, cwd, agent: 'claude', mode: 'edits', worktree: false });
  assert.equal(b.title, 'Carry on from @mention target: fix add() please', 'titles show the mention, not the token');
  const done = await until(async () => {
    const x = await session(b.id);
    return x.state === 'review' && x;
  });
  // The agent saw the title and id, and a note pointing at the tool.
  const sent = records(RECORD, 'claude').at(-1).stdin;
  assert.match(sent, new RegExp(`@mention target: fix add\\(\\) \\(wisp task ${a.id}\\)`));
  assert.match(sent, /<wisp-tasks>[\s\S]*wisp_session` \(mcp__wisp__wisp_session\)/);
  assert.equal(done.turns[0].prompt, `Carry on from @[mention target: fix add()](wisp:${a.id}) please`, 'stored as typed');
  const summary = done.turns.at(-1).presentation.blocks[0].summary;
  assert.match(summary, /read # Fake claude finished/);
  assert.match(summary, /listed \d+ tasks?(, the newest 2)?\. Read one with wisp_session\./);

  // Both reads need the run's token.
  for (const p of [`/api/internal/session/${b.id}?of=${a.id}`, `/api/internal/sessions/${b.id}`]) assert.equal((await fetch(`${base}${p}`)).status, 403);
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

// --- permissions: live approval (claude) and Allow & retry for what a turn's permissions blocked ---

const settled = (id, turns) =>
  until(async () => {
    const x = await session(id);
    return x.turns.length === turns && x.state === 'review' && x;
  });

test('claude: a permission prompt waits for the user; "always" lets the same call through after', async () => {
  const s = await api('/sessions', { prompt: 'APPROVE TWICE then publish', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  const waiting = await until(async () => {
    const x = await session(s.id);
    return x.state === 'waiting' && x;
  });
  assert.equal(waiting.ask.question, 'Allow Claude Code to run `npm publish`?');
  assert.equal(waiting.ask.context, 'Publish the package');
  assert.deepEqual(waiting.ask.permission, { tool: 'Bash', action: 'run `npm publish`', detail: 'npm publish' });
  assert.deepEqual(waiting.ask.options, ['Allow', 'Always allow in this task', 'Deny']);
  const list = await api('/sessions');
  assert.equal(list.find((x) => x.id === s.id).approval, true, 'the card and notification say approval, not question');
  assert.ok(records(RECORD, 'claude').at(-1).argv.join(' ').includes('--permission-prompt-tool mcp__wisp__approve'));

  await api(`/sessions/${s.id}/answer`, { text: 'Always allow in this task' });
  const done = await settled(s.id, 1); // the second, identical call never waited
  const allow = JSON.stringify({ behavior: 'allow', updatedInput: { command: 'npm publish', description: 'Publish the package' } });
  assert.equal(done.turns[0].presentation.blocks[0].summary, `Answer was: ${allow} | ${allow}`);
  assert.deepEqual(done.grants, [{ tool: 'Bash', detail: 'npm publish' }]);
  const labels = done.turns[0].activity.map((a) => a.label);
  assert.ok(labels.includes('You allowed (always in this task): run `npm publish`'));
  assert.ok(labels.includes('Allowed (always in this task): run `npm publish`'));
});

test('claude: answering a permission prompt in your own words denies it and passes them on', async () => {
  const s = await api('/sessions', { prompt: 'APPROVE then publish', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await until(async () => (await session(s.id)).state === 'waiting');
  await api(`/sessions/${s.id}/reply`, { text: 'do a dry run instead' }); // a follow-up while asked = the answer
  const done = await settled(s.id, 1);
  const deny = JSON.stringify({ behavior: 'deny', message: 'The user denied this and said: do a dry run instead' });
  assert.equal(done.turns[0].presentation.blocks[0].summary, `Answer was: ${deny}`);
  assert.ok(!done.grants);
});

test('claude: a refused call gets an Allow & retry card; the retry allows exactly that command', async () => {
  const s = await api('/sessions', { prompt: 'BLOCKED publish it', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  const done = await settled(s.id, 1);
  const turn = done.turns[0];
  assert.deepEqual(turn.presentation.blocks.map((b) => b.type), ['hero', 'blocked']);
  assert.deepEqual(turn.presentation.blocks[1].items, [{ tool: 'Bash', detail: 'npm publish' }]);
  assert.deepEqual(turn.blocked, [{ tool: 'Bash', detail: 'npm publish', rule: 'Bash(npm publish)' }]);

  const r = await api(`/sessions/${s.id}/approve`, { turnId: turn.id });
  assert.equal(r.scoped, true);
  const again = await settled(s.id, 2);
  assert.equal(again.turns[0].approval, 'allowed');
  assert.equal(again.turns[1].presentation.blocks[0].summary, 'Published.');
  assert.equal(again.turns[1].mode, 'edits', 'a scoped grant keeps the mode');
  const { argv, stdin } = records(RECORD, 'claude').at(-1);
  assert.ok(argv.includes('Bash(npm publish)'));
  assert.match(stdin, /blocked by your permissions last turn:\n- Bash: `npm publish`/);
  const twice = await fetch(`${base}/api/sessions/${s.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId: turn.id }) });
  assert.equal(twice.status, 409);
});

test('codex: what its sandbox refused (from its blocked block) retries in Full auto for one follow-up', async () => {
  const s = await api('/sessions', { prompt: 'BLOCKED publish it', cwd: makeRepo(), agent: 'codex', mode: 'edits' });
  const done = await settled(s.id, 1);
  const turn = done.turns[0];
  assert.deepEqual(turn.presentation.blocks.map((b) => b.type), ['hero', 'blocked']);
  assert.deepEqual(turn.blocked, [{ tool: 'shell', detail: 'npm publish', why: 'needs network access' }]);

  assert.equal((await api(`/sessions/${s.id}/approve`, { turnId: turn.id })).scoped, false);
  const again = await settled(s.id, 2);
  assert.equal(again.turns[1].mode, 'auto');
  assert.equal(again.mode, 'edits', 'only that follow-up ran in Full auto');
  assert.equal(again.turns[1].presentation.blocks[0].summary, 'Published.');
  assert.ok(records(RECORD, 'codex').at(-1).argv.includes('--dangerously-bypass-approvals-and-sandbox'));

  await api(`/sessions/${s.id}/reply`, { text: 'and the changelog' });
  await settled(s.id, 3);
  assert.ok(!records(RECORD, 'codex').at(-1).argv.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('opencode: a rejected permission retries with exactly that pattern allowed; deny just closes the card', async () => {
  const s = await api('/sessions', { prompt: 'BLOCKED publish it', cwd: makeRepo(), agent: 'opencode', mode: 'edits' });
  const done = await settled(s.id, 1);
  assert.deepEqual(done.turns[0].blocked, [{ tool: 'bash', detail: 'npm publish', rule: { permission: 'bash', patterns: ['npm publish'] } }]);
  await api(`/sessions/${s.id}/approve`, { turnId: done.turns[0].id });
  const again = await settled(s.id, 2);
  assert.equal(again.turns[1].presentation.blocks[0].summary, 'Published.');
  assert.deepEqual(JSON.parse(records(RECORD, 'opencode').at(-1).opencodeConfig).permission, { bash: { 'npm publish': 'allow' } });

  const other = await api('/sessions', { prompt: 'BLOCKED publish it', cwd: makeRepo(), agent: 'opencode', mode: 'edits' });
  const t = (await settled(other.id, 1)).turns[0];
  assert.deepEqual(await api(`/sessions/${other.id}/approve`, { turnId: t.id, allow: false }), { denied: true });
  const after = await session(other.id);
  assert.equal(after.turns.length, 1);
  assert.equal(after.turns[0].approval, 'denied');
});

// --- /btw: side questions answered next to the run, which carries on ---

const btwOf = (x, id) => x.turns.flatMap((t) => t.btw || []).find((b) => b.id === id);
const answered = (sid, id) =>
  until(async () => {
    const b = btwOf(await session(sid), id);
    return b?.status !== 'running' && b;
  });
async function del(p) {
  const r = await fetch(`${base}/api${p}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  return { status: r.status, body: await r.json() };
}

for (const agent of ['claude', 'codex', 'opencode']) {
  test(`${agent}: /btw mid-run is answered on a fork of the conversation; the run is not interrupted`, async () => {
    process.env.FAKE_HANG = '1';
    try {
      const s = await api('/sessions', { prompt: 'long task', cwd: makeRepo(), agent, mode: 'edits' });
      await until(async () => (await session(s.id)).agentSessionId);
      const q = await api(`/sessions/${s.id}/btw`, { text: '/btw did you update the docs?' });
      assert.equal(q.question, 'did you update the docs?');
      assert.equal(q.status, 'running');
      assert.equal(q.forked, true);

      const b = await answered(s.id, q.id);
      assert.equal(b.status, 'done', b.error);
      assert.equal(b.answer, 'Side answer (forked): did you update the docs?');
      const x = await session(s.id);
      assert.equal(x.state, 'running', 'the run carries on');
      assert.equal(x.turns.length, 1, 'no new turn');
      assert.equal(x.turns[0].status, 'running');
      assert.equal(x.agentSessionId, `${agent}-session-1`, 'the task keeps its own conversation');

      const rec = records(RECORD, 'btw').at(-1);
      assert.ok(rec.argv.includes(`${agent}-session-1`), 'forked from the running conversation');
      if (agent === 'claude') {
        assert.ok(rec.argv.includes('--fork-session') && rec.argv.includes('--no-session-persistence'));
        assert.equal(rec.argv[rec.argv.indexOf('--permission-mode') + 1], 'plan', 'read-only');
        assert.ok(!rec.argv.includes('--mcp-config'), 'no ask_user or delegate on the side');
      }
      if (agent === 'codex') assert.deepEqual(rec.argv.slice(rec.argv.indexOf('fork'), rec.argv.indexOf('fork') + 2), ['fork', 'codex-session-1']);
      if (agent === 'opencode') assert.ok(rec.argv.includes('--fork') && rec.argv.includes('plan'));
      await api(`/sessions/${s.id}/stop`, {});
    } finally {
      delete process.env.FAKE_HANG;
    }
  });
}

test('/btw through /reply (CLI, phone) is a side question too; it never answers a pending ask_user', async () => {
  process.env.FAKE_HANG = '1';
  try {
    const s = await api('/sessions', { prompt: 'long task', cwd: makeRepo(), agent: 'claude' });
    await until(async () => (await session(s.id)).agentSessionId);
    const r = await api(`/sessions/${s.id}/reply`, { text: '/BTW   which file are you in?' });
    assert.ok(r.btw && !r.interrupted && !r.queued);
    assert.equal(r.btw.question, 'which file are you in?');
    assert.equal((await answered(s.id, r.btw.id)).status, 'done');
    const x = await session(s.id);
    assert.equal(x.turns.length, 1);
    assert.equal(x.queue.length, 0);
    await api(`/sessions/${s.id}/stop`, {});
  } finally {
    delete process.env.FAKE_HANG;
  }

  const asking = await api('/sessions', { prompt: 'ASK before fixing add()', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await until(async () => (await session(asking.id)).state === 'waiting');
  const r = await api(`/sessions/${asking.id}/reply`, { text: '/btw why do you ask?' });
  assert.ok(r.btw);
  await answered(asking.id, r.btw.id);
  const x = await session(asking.id);
  assert.equal(x.state, 'waiting', 'still waiting on its own question');
  assert.equal(x.ask.question, 'Proceed with the fix?');
  await api(`/sessions/${asking.id}/answer`, { text: 'Yes' });
  await settled(asking.id, 1);
});

test('/btw still being answered when a follow-up starts a new turn moves to that turn', async () => {
  process.env.FAKE_HANG = '1';
  process.env.FAKE_BTW = 'slow';
  try {
    const s = await api('/sessions', { prompt: 'long task', cwd: makeRepo(), agent: 'claude' });
    await until(async () => (await session(s.id)).agentSessionId);
    const q = await api(`/sessions/${s.id}/btw`, { text: 'how far along are you?' });
    await api(`/sessions/${s.id}/reply`, { text: 'actually, do it differently' });
    const moved = await until(async () => {
      const x = await session(s.id);
      return x.turns.length === 2 && x;
    });
    assert.equal(moved.turns[0].btw, undefined);
    assert.deepEqual(moved.turns[1].btw.map((b) => b.id), [q.id]);
    assert.equal((await answered(s.id, q.id)).status, 'done');
    assert.equal((await session(s.id)).turns[1].btw[0].answer, 'Side answer (forked): how far along are you?');
    await api(`/sessions/${s.id}/stop`, {});
  } finally {
    delete process.env.FAKE_HANG;
    delete process.env.FAKE_BTW;
  }
});

test('/btw on a harness that cannot fork gets the task written out; after the run it adds no turn', async () => {
  const s = await api('/sessions', { prompt: 'fix add() in math.js', cwd: makeRepo(), agent: 'cursor' });
  await settled(s.id, 1);
  await new Promise((r) => setTimeout(r, 300)); // the CLI's exit lands after its result
  const done = await session(s.id);
  const q = await api(`/sessions/${s.id}/btw`, { text: 'what did you change?' });
  assert.equal(q.forked, false);
  const b = await answered(s.id, q.id);
  assert.equal(b.answer, 'Side answer (digest): what did you change?');
  const { stdin, argv } = records(RECORD, 'btw').at(-1);
  assert.match(stdin, /## The task so far/);
  assert.match(stdin, /\*\*User:\*\* fix add\(\) in math\.js/);
  assert.match(stdin, /math\.js/);
  assert.ok(!argv.includes('--resume'), 'a fresh run, not the task’s conversation');
  const x = await session(s.id);
  assert.equal(x.turns.length, 1);
  assert.equal(x.state, done.state);
  assert.equal(x.updatedAt, done.updatedAt, 'the card stays where it is in the feed');
});

test('/btw: a CLI that cannot fork falls back to the written-out task; dismiss stops and drops it', async () => {
  const s = await api('/sessions', { prompt: 'fix add()', cwd: makeRepo(), agent: 'claude' });
  await settled(s.id, 1);
  process.env.FAKE_BTW = 'nofork';
  try {
    const q = await api(`/sessions/${s.id}/btw`, { text: 'are the tests green?' });
    assert.equal(q.forked, true);
    const b = await answered(s.id, q.id);
    assert.equal(b.status, 'done', b.error);
    assert.equal(b.forked, false);
    assert.equal(b.answer, 'Side answer (digest): are the tests green?');
  } finally {
    delete process.env.FAKE_BTW;
  }

  process.env.FAKE_BTW = 'slow';
  try {
    const q = await api(`/sessions/${s.id}/btw`, { text: 'never mind' });
    assert.equal((await del(`/sessions/${s.id}/btw?item=${q.id}`)).status, 200);
    assert.equal(btwOf(await session(s.id), q.id), undefined);
    await new Promise((r) => setTimeout(r, 3500)); // its run would have answered by now
    assert.equal(btwOf(await session(s.id), q.id), undefined, 'a dismissed question stays gone');
    assert.equal((await del(`/sessions/${s.id}/btw?item=${q.id}`)).status, 404);
  } finally {
    delete process.env.FAKE_BTW;
  }

  await assert.rejects(api(`/sessions/${s.id}/btw`, { text: '/btw   ' }), /Type your question after \/btw/);
});
