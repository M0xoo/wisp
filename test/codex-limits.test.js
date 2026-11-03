// Codex limits told apart (server/router.js limitOf, server/pipeline.js #moveOn, server/runner.js
// #deviceLimit): a 429 while the plan has room rests the harness a minute, not ten, and is tried
// again once when nothing else can run; a device or session limit says what happened, without the
// usage-limit card and without touching other accounts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('codex-limits-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('codex-limits-claude-home');
process.env.CODEX_HOME = tmp('codex-limits-codex-home');
installFakeBins();
const { Pipeline } = await import('../server/pipeline.js');
const { BLIP_MS } = await import('../server/router.js');
const { startServer } = await import('../server/index.js');

// A Pipeline over stubs: the router records what it cooled and answers picks from a list.
function rig({ windows, picks, error = 'exceeded retry limit, last status: 429 Too Many Requests' }) {
  const cooled = [];
  const launched = [];
  const notes = [];
  const session = { id: 's1', agent: 'codex', account: '', auto: { strategy: 'single' }, route: { key: 'codex:gpt-5.6', label: 'Codex · gpt-5.6', goal: 'balanced' }, turns: [{ prompt: 'fix it' }] };
  const turn = { status: 'error', presentation: { blocks: [{ type: 'terminal', output: error }] } };
  const p = new Pipeline({
    store: { get: () => session, all: () => [session] },
    runner: { note: (s, t, { label }) => notes.push(label), settle: () => {} },
    router: { cool: (key, l) => (cooled.push({ key, ...l }), key), void: () => {}, choose: () => picks.shift() ?? null },
    settings: () => ({ escalate: false }),
    agents: () => [],
    windows: () => windows,
    launchSibling: async (s, pick, o) => (launched.push({ pick, ...o }), { id: 's2' }),
  });
  p.blipMs = 5;
  return { p, session, turn, cooled, launched, notes };
}

test('a Codex 429 with plan left: cooled a minute, not ten, and tried again once when nothing else can run', async () => {
  const r = rig({ windows: [{ id: 'five_hour', used: 0.3 }, { id: 'seven_day', used: 0.5 }], picks: [null, { key: 'codex:gpt-5.6', label: 'Codex · gpt-5.6' }] });
  await r.p.run(r.session, r.turn);
  assert.equal(r.cooled[0].ms, BLIP_MS);
  assert.equal(r.launched.length, 1);
  assert.equal(r.launched[0].pick.key, 'codex:gpt-5.6', 'the same harness, after the wait');
  assert.deepEqual(r.launched[0].tried, ['codex:gpt-5.6'], 'carried in tried: a second blip moves on, it doesn’t wait again');
  assert.ok(r.notes.some((n) => /too many requests.*not used up/.test(n)));
  assert.ok(r.notes.some((n) => /^Trying Codex · gpt-5\.6 again/.test(n)));
});

test('a second blip on the retried run moves on or settles; it never waits again', async () => {
  const r = rig({ windows: [{ id: 'five_hour', used: 0.3 }], picks: [null] });
  r.session.auto.tried = ['codex:gpt-5.6'];
  await r.p.run(r.session, r.turn);
  assert.equal(r.launched.length, 0);
  assert.equal(r.session.auto.busy, false);
});

test('a Codex 429 with a full window is the real limit: ten minutes, and the arm is struck off', async () => {
  const r = rig({ windows: [{ id: 'five_hour', used: 1 }], picks: [{ key: 'claude:', label: 'Claude Code' }] });
  await r.p.run(r.session, r.turn);
  assert.equal(r.cooled[0].ms, 10 * 60_000);
  assert.deepEqual(r.launched[0].tried, ['codex:gpt-5.6']);
  assert.equal(r.launched[0].pick.key, 'claude:');
});

// openai/codex#59045: codex ends the turn with "Selected model is at capacity" when OpenAI has no
// room for that model. It's the model being unavailable, not failing the task: Auto rests that
// model (not the whole harness) and moves the task on, saying so, even with plan left.
test('a Codex model at capacity: that model cools down and the task moves on, not counted as a failure', async () => {
  const r = rig({ error: 'Selected model is at capacity. Please try a different model.', windows: [{ id: 'five_hour', used: 0.3 }], picks: [{ key: 'codex:gpt-5.5', label: 'Codex · gpt-5.5' }] });
  await r.p.run(r.session, r.turn);
  assert.equal(r.cooled.length, 1, 'the arm is cooled');
  assert.equal(r.cooled[0].key, 'codex:gpt-5.6');
  assert.equal(r.cooled[0].scope, 'arm', 'only that model: another Codex model can run');
  assert.equal(r.cooled[0].ms, 10 * 60_000, 'not the one-minute “too many requests” blip');
  assert.equal(r.launched[0].pick.key, 'codex:gpt-5.5');
  assert.deepEqual(r.launched[0].tried, ['codex:gpt-5.6']);
  assert.ok(r.notes.some((n) => /Codex · gpt-5\.6 is at capacity · moving to Codex · gpt-5\.5/.test(n)), r.notes.join(' | '));
  assert.ok(!r.notes.some((n) => /too many requests/.test(n)));
});

// The device notice, end to end through a real server with the fake codex.
let srv;
let base;
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('a device or session limit: a clear notice on the task, no usage-limit card', async () => {
  process.env.FAKE_LIMIT_ONCE = path.join(tmp('codex-device'), 'hit');
  process.env.FAKE_LIMIT_TEXT = 'Too many active sessions: you are signed in on too many devices.';
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'codex', worktree: false });
    const x = await until(async () => {
      const v = await api(`/sessions/${s.id}`);
      return v.state === 'review' && v.turns.at(-1).status !== 'running' && v;
    }, { timeout: 30_000 });
    const t = x.turns[0];
    assert.equal(t.status, 'error');
    assert.equal(t.limit, undefined, 'not a usage limit: no wait / other account card');
    const [hero, steps, term] = t.presentation.blocks;
    assert.match(hero.title, /too many devices/);
    assert.match(hero.summary, /usage isn’t used up/);
    assert.equal(steps.type, 'checklist');
    assert.match(steps.items[0].text, /sign out there/);
    assert.match(term.output, /Too many active sessions/);
  } finally {
    delete process.env.FAKE_LIMIT_ONCE;
    delete process.env.FAKE_LIMIT_TEXT;
  }
});
