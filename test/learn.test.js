// Learning from sessions: the retro that runs after a session goes quiet, the preferences and
// lessons it keeps (capped, mergeable, revisable), and how they reach the next agent's prompt.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('learn-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('learn-home');
process.env.WISP_RETRO_IDLE_MS = '50';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { clean, merge, parseRetro, digest, Preferences, MAX_ITEMS, MAX_LEN } = await import('../server/preferences.js');

test('clean dedupes, trims and caps', () => {
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `item ${i}`);
  assert.equal(clean(many).length, MAX_ITEMS);
  assert.equal(clean(many).at(-1), `item ${MAX_ITEMS + 4}`, 'newest kept');
  assert.deepEqual(clean(['  Use pnpm ', 'use PNPM', '', null]), ['Use pnpm']);
  assert.equal(clean(['x'.repeat(500)])[0].length, MAX_LEN);
});

test('merge applies the retro diff on top of edits made meanwhile', () => {
  const snapshot = ['a', 'b'];
  const proposal = ['a', 'c']; // retro dropped b, added c
  const current = ['a', 'b', 'mine']; // user added "mine" while it ran
  assert.deepEqual(merge(snapshot, proposal, current), { next: ['a', 'mine', 'c'], added: ['c'], removed: ['b'] });
});

test('parseRetro reads fenced or bare JSON and leaves omitted lists alone', () => {
  const r = parseRetro('Sure.\n```json\n{"global": {"preferences": ["Be terse"]}, "project": {"lessons": ["Use node --test"]}}\n```');
  assert.deepEqual(r.global, { preferences: ['Be terse'], lessons: null });
  assert.deepEqual(r.project, { preferences: null, lessons: ['Use node --test'] });
  assert.equal(parseRetro('no json here'), null);
});

test('digest carries corrections, failures and commands, not the whole transcript', () => {
  const s = {
    turns: [
      {
        prompt: 'run the tests',
        status: 'done',
        activity: [
          { kind: 'run', label: 'Run tests', detail: 'npm test -- foo' },
          { kind: 'error', label: 'Bash failed: jest: command not found' },
          { kind: 'run', label: 'Run tests', detail: 'node --test test/foo.test.js' },
          { kind: 'read', label: 'Reading a.js' },
        ],
        presentation: { blocks: [{ type: 'hero', title: 'Tests pass', summary: 'Used node --test', status: 'done' }] },
      },
      { prompt: 'no, never commit without asking', status: 'stopped', activity: [] },
    ],
  };
  const d = digest(s);
  assert.match(d, /\$ npm test -- foo\nFAILED: Bash failed: jest: command not found\n\$ node --test/);
  assert.match(d, /Agent reported \[done\]: Tests pass/);
  assert.match(d, /Follow-up 2\nUser: no, never commit without asking\n\(The user stopped/);
  assert.doesNotMatch(d, /Reading a\.js/);
  assert.match(digest(s, 1), /^### Follow-up 2/, 'only turns after the last retro');
});

test('prompt section is empty until something is learned', () => {
  const p = new Preferences(tmp('prefs'));
  assert.equal(p.prompt('/x'), '');
  p.set('global', 'preferences', ['Be terse']);
  p.set('/x', 'lessons', ['Use node --test']);
  const text = p.prompt('/x');
  assert.match(text, /How this user likes to work \(everywhere\):\n- Be terse/);
  assert.match(text, /Lessons from earlier mistakes \(this project\):\n- Use node --test/);
  assert.doesNotMatch(p.prompt('/other'), /node --test/, 'project lessons stay in their project');
});

// --- through a real server ------------------------------------------------------------------

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const settled = (id, turns) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state === 'review' && x.turns.length === turns && x;
});
const systemPromptOf = (rec) => rec.argv[rec.argv.indexOf('--append-system-prompt') + 1];

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

test('a finished session is retro’d, and the next session starts with what was learned', async () => {
  const cwd = makeRepo();
  process.env.FAKE_RETRO = JSON.stringify({
    global: { preferences: ['Keep reports short'], lessons: [] },
    project: { preferences: [], lessons: ['Run tests with node --test; npm test needs a build first'] },
  });
  const s = await api('/sessions', { body: { prompt: 'fix add()', cwd, agent: 'claude' } });
  await settled(s.id, 1);

  const learned = await until(async () => {
    const p = await api('/preferences');
    return p.projects.length && p;
  });
  assert.deepEqual(learned.global.preferences, ['Keep reports short']);
  assert.deepEqual(learned.projects[0].lessons, ['Run tests with node --test; npm test needs a build first']);
  assert.equal(learned.history[0].added.length, 2);
  assert.equal(learned.history[0].status, 'learned');

  // The retro saw the failure and the commands, ran read-only on a cheap model, and was told what it already knew.
  const retro = records(RECORD, 'retro').at(-1);
  assert.match(retro.stdin, /FAILED: Bash failed: 1 failing/);
  assert.match(retro.stdin, /\$ npm test/);
  assert.equal(retro.argv[retro.argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(retro.argv[retro.argv.indexOf('--model') + 1], 'haiku');
  assert.ok(!retro.argv.includes('--mcp-config'), 'no ask_user in a retro');

  // A new session in the same project gets both lists.
  const s2 = await api('/sessions', { body: { prompt: 'another task', cwd, agent: 'claude' } });
  await settled(s2.id, 1);
  const sp = systemPromptOf(records(RECORD, 'claude').at(-1));
  assert.match(sp, /- Keep reports short/);
  assert.match(sp, /- Run tests with node --test/);
  // …and one elsewhere only the global one.
  const s3 = await api('/sessions', { body: { prompt: 'elsewhere', cwd: makeRepo(), agent: 'claude' } });
  await settled(s3.id, 1);
  const sp3 = systemPromptOf(records(RECORD, 'claude').at(-1));
  assert.match(sp3, /- Keep reports short/);
  assert.doesNotMatch(sp3, /node --test/);

  await until(() => records(RECORD, 'retro').length === 3); // s2's and s3's retros spawned with the old reply

  // The user changes their mind in a follow-up: the next retro revises instead of piling up.
  process.env.FAKE_RETRO = JSON.stringify({ global: { preferences: ['Give detailed reports with every step'], lessons: [] } });
  await api(`/sessions/${s.id}/reply`, { body: { text: 'actually, I want detailed reports' } });
  await settled(s.id, 2);
  const revised = await until(async () => {
    const p = await api('/preferences');
    return p.global.preferences[0] === 'Give detailed reports with every step' && p;
  });
  assert.deepEqual(revised.global.preferences, ['Give detailed reports with every step']);
  assert.equal(revised.projects[0].lessons.length, 1, 'lists the retro left out are untouched');
  const second = records(RECORD, 'retro').find((r) => r.stdin.includes('actually, I want'));
  assert.match(second.stdin, /Follow-up 2\nUser: actually, I want detailed reports/);
  assert.doesNotMatch(second.stdin, /Request 1/, 'only the new turn is re-read');
  assert.match(second.stdin, /Keep reports short/, 'given what it knew');
  delete process.env.FAKE_RETRO;
  await until(() => records(RECORD, 'retro').length === 4); // one per settled session/follow-up

  // Every run is in the log, including ones that learned nothing, so Settings can show them all.
  const log = await until(async () => {
    const p = await api('/preferences');
    return p.history.length === 4 && !p.running && p;
  });
  const bySession = (id) => log.history.find((h) => h.sessionId === id);
  assert.equal(bySession(s2.id).status, 'nothing', 's2 repeated what was already known');
  assert.deepEqual(bySession(s2.id).added, []);
  assert.equal(log.history[0].sessionId, s.id, 'newest first');
  assert.equal(log.history[0].turns, 1, 'the follow-up retro read one turn');

});

test('settings can edit the lists, and turning learning off stops both learning and applying', async () => {
  const cwd = makeRepo();
  await api('/preferences', { method: 'PUT', body: { scope: 'global', kind: 'lessons', items: ['Never force-push', 'Never force-push', ''] } });
  assert.deepEqual((await api('/preferences')).global.lessons, ['Never force-push']);
  await assert.rejects(api('/preferences', { method: 'PUT', body: { scope: 'relative/path', kind: 'lessons', items: [] } }), /scope/);
  await assert.rejects(api('/preferences', { method: 'PUT', body: { scope: 'global', kind: 'nope', items: [] } }), /kind/);

  await api('/config', { method: 'PATCH', body: { defaults: { learn: 'off' } } });
  const retros = records(RECORD, 'retro').length;
  const s = await api('/sessions', { body: { prompt: 'task', cwd, agent: 'claude' } });
  await settled(s.id, 1);
  assert.doesNotMatch(systemPromptOf(records(RECORD, 'claude').at(-1)), /What wisp has learned/);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(records(RECORD, 'retro').length, retros, 'no retro while off');
  assert.equal((await api('/preferences')).enabled, false);
  await api('/config', { method: 'PATCH', body: { defaults: { learn: 'on' } } });
});

test('a retro whose reply cannot be read is logged as failed and changes nothing', async () => {
  const before = await api('/preferences');
  process.env.FAKE_RETRO = 'Sorry, I cannot help with that.';
  try {
    const s = await api('/sessions', { body: { prompt: 'task', cwd: makeRepo(), agent: 'claude' } });
    await settled(s.id, 1);
    const after = await until(async () => {
      const p = await api('/preferences');
      return p.history[0]?.sessionId === s.id && p;
    });
    assert.equal(after.history[0].status, 'failed');
    assert.match(after.history[0].error, /Unreadable reply: Sorry/);
    assert.deepEqual(after.global, before.global);
  } finally {
    delete process.env.FAKE_RETRO;
  }
});
