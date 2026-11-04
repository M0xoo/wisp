// Lean Claude Code runs (server/lean.js): wisp's own side runs (judges, reviews, the retro) get
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC by default; tasks, crew jobs and automations don't (it
// drops claude.ai connectors and org memory), unless the setting is 'all' or the task asks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('lean-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('lean-claude-home'); // never this computer's ~/.claude
delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; // the runner's own shell may export it
const RECORD = tmp('lean-record');
process.env.FAKE_RECORD = RECORD;
installFakeBins();
const { startServer } = await import('../server/index.js');
const { leanTask, leanOn, LEAN_ENV } = await import('../server/lean.js');
const { askJson } = await import('../server/quick.js');
const { adapters } = await import('../server/adapters/index.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
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
const ended = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && x;
}, { timeout: 30_000 });
// The last claude run whose prompt has this word.
const runFor = (word) => records(RECORD, 'claude').filter((r) => r.stdin.includes(word)).at(-1);

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

test('leanOn / leanTask: side runs lean unless off; a task only with all or its own choice', () => {
  assert.equal(LEAN_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(leanOn({}), true, 'side runs: on by default');
  assert.equal(leanOn({ leanRuns: 'on' }), true);
  assert.equal(leanOn({ leanRuns: 'all' }), true);
  assert.equal(leanOn({ leanRuns: 'off' }), false);
  assert.equal(leanOn({ leanRuns: 'bogus' }), true, 'an unknown value reads as the default');
  const tasks = [{}, { crew: { id: 'm' } }, { delegated: { by: 'x' } }, { parentId: 'p' }, { origin: { kind: 'recipe' } }, { origin: { kind: 'trigger' } }, { origin: { kind: 'later', name: 'Scheduled' } }, { origin: { kind: 'telegram' } }];
  for (const s of tasks) {
    assert.equal(leanTask(s, {}), false, `not lean by default: ${JSON.stringify(s)}`);
    assert.equal(leanTask(s, { leanRuns: 'on' }), false, `on is side runs only: ${JSON.stringify(s)}`);
    assert.equal(leanTask(s, { leanRuns: 'all' }), true, `all: ${JSON.stringify(s)}`);
    assert.equal(leanTask(s, { leanRuns: 'off' }), false);
  }
  assert.equal(leanTask({ lean: 'on' }, { leanRuns: 'off' }), true, 'a task can opt in');
  assert.equal(leanTask({ crew: { id: 'm' }, lean: 'off' }, { leanRuns: 'all' }), false, 'and out');
});

test('claude adapter: quiet sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, otherwise it isn\'t set', async () => {
  const go = (quiet, word) => adapters.claude.run({ prompt: word, cwd: makeRepo(), mode: 'plan', model: '', systemPrompt: '', attachments: [], quiet, onEvent: () => {} }).done;
  await go(true, 'adapterquiet');
  await go(false, 'adapterloud');
  assert.equal(runFor('adapterquiet').nonessential, '1');
  assert.equal(runFor('adapterloud').nonessential, undefined);
});

test('side runs (judge, review: askJson) are lean; tasks, crew-like and recipe runs aren\'t; all makes them lean; PATCH opts in', async () => {
  const cwd = makeRepo();
  // What goal judges, the judge, the scout and review by another harness run through (server/quick.js).
  const side = (word) => askJson({ agents: [], prompt: `judge this ${word}`, cwd, pick: { agent: 'claude', model: '' } });
  await side('side1');
  assert.equal(runFor('side1').nonessential, '1', 'a judge/review run: lean by default');

  const mine = await api('/sessions', { prompt: 'fix the add bug mine1', cwd, agent: 'claude', worktree: false });
  await ended(mine.id);
  assert.equal(runFor('mine1').nonessential, undefined, 'your own task: not lean');

  const r = await api('/recipes', { name: 'Nightly', prompt: 'fix the add bug recipe1', agent: 'claude', mode: 'plan' });
  const bg = await api(`/recipes/${r.id}/run`, { cwd });
  await ended(bg.id);
  assert.equal(runFor('recipe1').nonessential, undefined, 'an automation: not lean by default (it may need claude.ai connectors)');

  // This task only: on for yours; then null goes back to the setting.
  await assert.rejects(api(`/sessions/${mine.id}`, { lean: 'maybe' }, 'PATCH'), /lean must be on, off or null/);
  assert.equal((await api(`/sessions/${mine.id}`, { lean: 'on' }, 'PATCH')).lean, 'on');
  await api(`/sessions/${mine.id}/reply`, { text: 'again mine2' });
  await until(async () => runFor('mine2'), { timeout: 30_000 });
  await ended(mine.id);
  assert.equal(runFor('mine2').nonessential, '1', 'opted in');
  assert.equal((await api(`/sessions/${mine.id}`, { lean: null }, 'PATCH')).lean, undefined);

  await assert.rejects(api('/config', { defaults: { leanRuns: 'some' } }, 'PATCH'), /leanRuns must be one of off, on, all/);
  try {
    // all: a recipe run is lean too.
    await api('/config', { defaults: { leanRuns: 'all' } }, 'PATCH');
    const r2 = await api('/recipes', { name: 'Nightly two', prompt: 'fix the add bug recipe2', agent: 'claude', mode: 'plan' });
    const bg2 = await api(`/recipes/${r2.id}/run`, { cwd });
    await ended(bg2.id);
    assert.equal(runFor('recipe2').nonessential, '1', 'all: an automation is lean');
    // off: not even a side run.
    await api('/config', { defaults: { leanRuns: 'off' } }, 'PATCH');
    await side('side2');
    assert.equal(runFor('side2').nonessential, undefined, 'off: a side run is not lean');
  } finally {
    await api('/config', { defaults: { leanRuns: 'on' } }, 'PATCH');
  }
});
