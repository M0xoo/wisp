// Subagents on Haiku (Settings → Usage, defaults.subagentModel): Claude runs get
// CLAUDE_CODE_SUBAGENT_MODEL and CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL (never _FORCE), the turn keeps
// it (turn.run.subagentModel), and the receipt offers it when same-model subagents wrote ≥40%.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('submodel-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('submodel-claude-home'); // never this computer's ~/.claude
for (const k of ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) delete process.env[k]; // the runner's own shell may export them
const RECORD = tmp('submodel-record');
process.env.FAKE_RECORD = RECORD;
process.env.FAKE_SUBAGENTS = '2';
installFakeBins();
const { startServer } = await import('../server/index.js');
const { adapters } = await import('../server/adapters/index.js');
const { SUBAGENT_MODELS } = await import('../server/adapters/claude.js');
const { offerSubagentModel, sameModelShare, subagentTip, SUBAGENT_OFFER, SUBAGENT_OFFER_AT } = await import('../web/js/receipt.js');

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

test('claude adapter: subagentModel sets both subagent env vars, never _FORCE; unset or unknown leaves them alone', async () => {
  assert.deepEqual(SUBAGENT_MODELS, ['', 'haiku', 'sonnet']);
  const go = (subagentModel, word) => adapters.claude.run({ prompt: word, cwd: makeRepo(), mode: 'plan', model: '', systemPrompt: '', attachments: [], subagentModel, onEvent: () => {} }).done;
  await go('haiku', 'adapterhaiku');
  await go('', 'adapterdefault');
  await go('opus-max', 'adapterbogus');
  const h = runFor('adapterhaiku');
  assert.equal(h.subagentModel, 'haiku');
  assert.equal(h.workflowSubagentModel, 'haiku');
  assert.equal(h.subagentForce, undefined, 'an Agent call’s own model still wins');
  for (const w of ['adapterdefault', 'adapterbogus']) {
    assert.equal(runFor(w).subagentModel, undefined, w);
    assert.equal(runFor(w).workflowSubagentModel, undefined, w);
  }
});

test('the setting: refused unless one of the three; a Claude task runs its subagents on it and the turn says so', async () => {
  const cwd = makeRepo();
  const first = await api('/sessions', { prompt: 'fix the add bug subdefault', cwd, agent: 'claude', worktree: false });
  const a = await ended(first.id);
  assert.equal(runFor('subdefault').subagentModel, undefined, 'by default: the task’s model');
  const t0 = a.turns.at(-1);
  assert.equal(t0.run?.subagentModel, undefined);
  assert.equal(t0.stats.subagents[0].model, 'claude-opus-5-5');
  assert.equal(t0.stats.subagents[0].same, true, 'on the main thread’s model');
  assert.ok(offerSubagentModel(t0, '', 'claude'), `the receipt offers Haiku (${Math.round(sameModelShare(t0) * 100)}% of the output)`);

  await assert.rejects(api('/config', { defaults: { subagentModel: 'opus' } }, 'PATCH'), /subagentModel must be/);
  await api('/config', { defaults: { subagentModel: 'haiku' } }, 'PATCH');
  try {
    const second = await api('/sessions', { prompt: 'fix the add bug subhaiku', cwd, agent: 'claude', worktree: false });
    const b = await ended(second.id);
    const r = runFor('subhaiku');
    assert.equal(r.subagentModel, 'haiku');
    assert.equal(r.workflowSubagentModel, 'haiku');
    assert.equal(r.subagentForce, undefined);
    const t1 = b.turns.at(-1);
    assert.equal(t1.run?.subagentModel, 'haiku', 'the turn keeps it for its receipt');
    assert.match(t1.stats.subagents[0].model, /haiku/);
    assert.equal(t1.stats.subagents[0].same, undefined);
    assert.equal(offerSubagentModel(t1, 'haiku', 'claude'), false);
    assert.match(subagentTip(t1), /Subagents on Haiku \(Settings → Usage\)/);
  } finally {
    await api('/config', { defaults: { subagentModel: '' } }, 'PATCH');
  }
});

test('receipt: the offer says where Haiku pays off', () => {
  assert.match(SUBAGENT_OFFER, /^Run subagents on Haiku\b/);
  assert.match(SUBAGENT_OFFER, /best on large repos and read-heavy work/);
});

test('receipt: the offer needs ≥40% of the output from subagents on the task’s model, a Claude turn, and the setting unset', () => {
  const turn = (same, other, total = 100) => ({ stats: { totals: {}, outputTokens: 10, models: [{ model: 'claude-opus-5-5', input: 0, output: total, cacheRead: 0, cacheWrite: 0 }], subagents: [{ type: 'Explore', calls: 1, output: same, model: 'claude-opus-5-5', same: true }, { type: 'web-fetch', calls: 1, output: other, model: 'claude-haiku-4-5' }].filter((x) => x.output) } });
  assert.equal(SUBAGENT_OFFER_AT, 0.4);
  assert.equal(offerSubagentModel(turn(40, 0), '', 'claude'), true, 'exactly 40%');
  assert.equal(offerSubagentModel(turn(39, 30), '', 'claude'), false, 'other-model subagents don’t count');
  assert.equal(offerSubagentModel(turn(80, 0), 'sonnet', 'claude'), false, 'already set');
  assert.equal(offerSubagentModel({ ...turn(80, 0), run: { subagentModel: 'haiku' } }, '', 'claude'), false, 'this turn ran on Haiku');
  assert.equal(offerSubagentModel(turn(80, 0), '', 'codex'), false, 'Claude only');
  assert.equal(offerSubagentModel({ stats: {} }, '', 'claude'), false, 'no subagents');
  assert.equal(sameModelShare({ stats: { outputTokens: 0 } }), 0);
});
