// Compact now (web/js/cold-cache.js compactOffer, POST /sessions/:id/compact): what a real /compact
// reports (test/fixtures/claude-compact.jsonl, claude 2.1.316), when it's offered and what its turn
// leaves alone. makeRepo() as cwd, the fake CLI, no network.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBins, makeRepo, records, taskRuns, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('compact-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('compact-claude-home');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { adapters } = await import('../server/adapters/index.js');
const { Guard } = await import('../server/guard.js');
const { COMPACT_MIN, GRACE, coldCache, compactNote, compactOffer, compactTip, compactUntil } = await import('../web/js/cold-cache.js');
const { receiptOf, receiptParts } = await import('../web/js/receipt.js');

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-compact.jsonl', import.meta.url));
const H = 3_600_000;
const M = 60_000;
const T0 = 1_800_000_000_000;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
let srv;
let base;
async function call(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
async function api(p, body, method) {
  const r = await call(p, body, method);
  assert.ok(r.status < 300, `${p}: ${r.status} ${r.json.error}`);
  return r.json;
}
const ended = (id, n) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === n && x.turns.at(-1).status !== 'running' && x.state !== 'running' && x;
  }, { timeout: 30_000 });
const withEnv = async (env, fn) => {
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
};
// A large warm Claude task on Opus, one turn old: what Compact now is for.
const warm = (env = {}) =>
  withEnv({ FAKE_CONTEXT: '1h', ...env }, async () => {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false, confirmLimit: true });
    await ended(s.id, 1);
    return s;
  });

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

// --- the adapter -----------------------------------------------------------------------------

const resultsOf = async (file, opts = {}) =>
  withEnv({ FAKE_REPLAY: file }, async () => {
    const events = [];
    await adapters.claude.run({ prompt: '/compact', cwd: makeRepo(), mode: 'edits', onEvent: (e) => events.push(e), ...opts }).done;
    return events.filter((e) => e.type === 'result');
  });
const lines = () => fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const replay = (rows) => {
  const f = path.join(tmp('compact-replay'), 'stream.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
const isResult = (m) => m.type === 'result';
const taskOf = (stats, extra = {}) => ({ agent: 'claude', agentSessionId: 'sess', state: 'review', turns: [{ status: 'done', agent: 'claude', endedAt: T0, stats: { contextTokens: 480_000, cacheTtlMs: H, outputTokens: 500, models: [{ model: 'claude-opus-5-5', input: 10, output: 500, cacheRead: 480_000, cacheWrite: 1000 }] } }, { status: 'done', agent: 'claude', endedAt: T0 + M, stats }], ...extra });

test('(a) the recorded /compact: final, contextTokens 0, stats.compact, stats.models, the cold line gone', async () => {
  const prior = { costUsd: 0.005, models: [{ model: 'claude-haiku-5-5', input: 2000, output: 1500, cacheRead: 100_000, cacheWrite: 20_000 }] };
  const [r, ...more] = await resultsOf(FIXTURE, { prior, resumeId: 'sess-compact' });
  assert.equal(more.length, 0);
  assert.equal(r.isError, false);
  assert.strictEqual(r.stats.contextTokens, 0);
  assert.deepEqual(r.stats.compact, { pre: 34596, post: 9521 });
  assert.equal(r.text, 'Compacted from 35k to 10k tokens.');
  assert.deepEqual(r.stats.models, [{ model: 'claude-haiku-5-5', input: 47, output: 295, cacheRead: 46151, cacheWrite: 3141 }], 'what this turn added, not the conversation');
  assert.equal(r.stats.costUsd, 0.0021867, 'a delta on the prior');
  assert.equal(r.stats.totals.costUsd, 0.007186735);
  assert.equal(coldCache(taskOf(r.stats), T0 + 9 * H), null, 'the cold line is gone');
});

test('(a) a background notification\'s empty result first, the /compact second: the compact is the turn', async () => {
  const rows = lines();
  const empty = { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, session_id: 'sess-compact', total_cost_usd: 0.007, usage: {} };
  const [r, ...more] = await resultsOf(replay([empty, ...rows]));
  assert.equal(more.length, 0);
  assert.deepEqual(r.stats.compact, { pre: 34596, post: 9521 });
  // And the early path still works when nothing follows: that empty result is all there is.
  const [only] = await resultsOf(replay([empty]));
  assert.equal(only.text, '');
  assert.equal(only.stats.compact, undefined);
  assert.equal(only.isError, false);
});

test('(a) an is_error result stays an error', async () => {
  const rows = lines().map((m) => (isResult(m) ? { ...m, is_error: true, subtype: 'error_during_execution', result: 'It broke' } : m));
  const [r] = await resultsOf(replay(rows));
  assert.equal(r.isError, true);
  assert.equal(r.text, 'It broke');
  assert.equal(r.stats.compact, undefined);
});

test('(d) local_command with no boundary: its own words or Nothing was compacted, never a claim', async () => {
  const none = lines().filter((m) => m.subtype !== 'compact_boundary');
  const said = await resultsOf(replay(none.map((m) => (isResult(m) ? { ...m, result: 'Some words we never saw' } : m))));
  assert.equal(said[0].text, 'Some words we never saw');
  assert.deepEqual(said[0].stats.compact, { none: true });
  assert.ok(!('contextTokens' in said[0].stats));
  const quiet = await resultsOf(replay(none));
  assert.equal(quiet[0].text, 'Nothing was compacted.');
});

test('(d) a status other than success: as none, with its error text', async () => {
  const failed = lines()
    .filter((m) => m.subtype !== 'compact_boundary')
    .map((m) => (m.compact_result ? { ...m, compact_result: 'failed', compact_error: 'Conversation too long.' } : m))
    .map((m) => (isResult(m) ? { ...m, local_command: undefined } : m));
  const [r] = await resultsOf(replay(failed));
  assert.equal(r.text, 'Conversation too long.');
  assert.deepEqual(r.stats.compact, { none: true });
  assert.ok(!('contextTokens' in r.stats));
});

test('(b) the fake\'s /compact is the recorded stream: the same types, keys and metadata, in order', async () => {
  const dir = tmp('compact-stream');
  const raw = [];
  const { spawnSync } = await import('node:child_process');
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
  const copy = path.join(dir, 'claude.mjs');
  fs.copyFileSync(bin, copy);
  const out = spawnSync(process.execPath, [copy, '-p', '--resume', 'sess-compact'], { input: '/compact', cwd: makeRepo(), encoding: 'utf8' }).stdout;
  raw.push(...out.trim().split('\n').map((l) => JSON.parse(l)));
  const shape = (rows) => rows.filter((m) => m.type !== 'rate_limit_event').map((m) => [m.type, m.subtype || '', m.status === undefined ? '-' : m.status, m.compact_result || '']);
  assert.deepEqual(shape(raw), shape(lines()));
  const keys = (rows) => Object.keys(rows.find((m) => m.subtype === 'compact_boundary').compact_metadata);
  assert.deepEqual(keys(raw), keys(lines()));
  const deep = (m) => [Object.keys(m.preserved_segment), Object.keys(m.preserved_messages)];
  const metaOf = (rows) => rows.find((m) => m.subtype === 'compact_boundary').compact_metadata;
  assert.deepEqual(deep(metaOf(raw)), deep(metaOf(lines())));
  const [a, b] = [raw.find(isResult), lines().find(isResult)];
  for (const k of ['subtype', 'is_error', 'result', 'num_turns', 'stop_reason', 'local_command']) assert.deepEqual(a[k], b[k], k);
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) assert.equal(a.usage[k], 0, k);
  assert.ok(a.total_cost_usd > 0 && Object.keys(a.modelUsage).length);
});

// --- the offer -------------------------------------------------------------------------------

const stats = (contextTokens, cacheTtlMs = H, models = [{ model: 'claude-opus-5-5', input: 10, output: 500, cacheRead: contextTokens, cacheWrite: 1000 }], extra = {}) => ({ contextTokens, cacheTtlMs, outputTokens: 500, models, ...extra });
const turn = (st, extra = {}) => ({ status: 'done', agent: 'claude', endedAt: T0, stats: st, ...extra });
const task = (turns, extra = {}) => ({ agent: 'claude', agentSessionId: 'sess-1', state: 'review', turns, ...extra });
const big = (extra) => task([turn(stats(480_000))], extra);

test('the prices: Opus at 480k is $3.84 cold and $0.74 compacted', () => {
  const o = compactOffer(big(), T0);
  assert.deepEqual(Object.keys(o), ['tokens', 'compact', 'cold']);
  assert.equal(o.tokens, 480_000);
  assert.equal(o.cold.toFixed(2), '3.84');
  assert.equal(o.compact.toFixed(2), '0.74');
  assert.equal(compactNote(o), 'About $0.74 now, $3.84 once the cache is cold');
});

test('the tooltip says once what the dollars are, and has none on a model with no price', () => {
  assert.match(compactTip({ tokens: 480_000, compact: 0.74, cold: 3.84 }), /API list prices.*On a plan you pay no dollars/);
  assert.doesNotMatch(compactNote({ tokens: 480_000, compact: 0.74, cold: 3.84 }), /plan|list/i);
  assert.doesNotMatch(compactTip({ tokens: 480_000, compact: null, cold: null }), /dollars|prices/);
});

test('a 5-minute cache writes at 1.25× input', () => {
  const o = compactOffer(task([turn(stats(480_000, 5 * M))]), T0);
  assert.equal(o.cold.toFixed(2), '2.40');
  assert.equal(o.compact.toFixed(3), '0.646');
});

test('every model priced: Sonnet, both Fables', () => {
  const on = (id) => compactOffer(task([turn(stats(480_000, H, [{ model: id, input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }]))]), T0);
  assert.equal(on('claude-sonnet-5-5').cold.toFixed(2), '1.92');
  assert.equal(on('claude-fable-5-1').cold.toFixed(2), '9.60');
  assert.equal(on('claude-fable-5').cold.toFixed(2), '9.60');
  assert.equal(on('claude-opus-5-5[1m]').cold.toFixed(2), '3.84', 'a long-context id is the same model');
});

test('an unknown model: the offer stands, with tokens only', () => {
  const o = compactOffer(task([turn(stats(480_000, H, [{ model: 'claude-haiku-5-5', input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }]))]), T0);
  assert.deepEqual(o, { tokens: 480_000, compact: null, cold: null });
  assert.equal(compactNote(o), 'About 480k tokens');
  assert.deepEqual(compactOffer(task([turn(stats(480_000, H, undefined))]), T0).cold, 3.84);
  const noList = stats(480_000);
  delete noList.models;
  assert.equal(compactOffer(task([turn(noList)]), T0).compact, null);
});

test('the main thread\'s model, not a subagent\'s: more output on Haiku or Fable changes nothing', () => {
  const models = [{ model: 'claude-fable-5-1', input: 100, output: 90_000, cacheRead: 50_000, cacheWrite: 0 }, { model: 'claude-opus-5-5', input: 10, output: 500, cacheRead: 480_000, cacheWrite: 1000 }];
  const st = stats(480_000, H, models, { subagents: [{ type: 'Explore', calls: 3, read: 50_000, output: 90_000, model: 'claude-fable-5-1' }] });
  assert.equal(compactOffer(task([turn(st)]), T0).cold.toFixed(2), '3.84');
});

test('200,000 is offered, 199,999 isn\'t', () => {
  assert.equal(COMPACT_MIN, 200_000);
  assert.equal(compactOffer(task([turn(stats(199_999))]), T0), null);
  assert.equal(compactOffer(task([turn(stats(200_000))]), T0).tokens, 200_000);
});

test('warm only: at TTL-1 yes, at the TTL gone, well before the cold line says anything', () => {
  assert.ok(compactOffer(big(), T0 + H - 1));
  assert.equal(compactOffer(big(), T0 + H), null);
  assert.equal(coldCache(big(), T0 + H).cold, false, 'the cold line isn\'t up yet');
  assert.equal(compactUntil(big()), T0 + H);
  assert.ok(GRACE > 1);
  const five = task([turn(stats(480_000, 5 * M))]);
  assert.ok(compactOffer(five, T0 + 5 * M - 1));
  assert.equal(compactOffer(five, T0 + 5 * M), null);
});

test('only a task of your own, on Claude, not limited, not just failed', () => {
  assert.ok(compactOffer(big(), T0));
  for (const x of [{ agent: 'codex' }, { sideOf: { id: 'x' } }, { parentId: 'x' }, { delegated: true }, { relay: { machine: 'm' } }, { kind: 'spell' }, { tui: true }]) assert.equal(compactOffer(big(x), T0), null, JSON.stringify(x));
  assert.equal(compactOffer(task([turn(stats(480_000), { limit: { until: T0 + H } })]), T0), null);
  assert.equal(compactOffer(task([turn(stats(480_000)), turn({ compact: { none: true }, outputTokens: 0 })]), T0), null);
  assert.equal(compactOffer(null), null);
  assert.equal(compactOffer(task([turn(stats(480_000)), { status: 'held', agent: 'claude' }]), T0), null, 'held turns aren\'t offered');
});

test('a compact turn and a window\'s runs: no sample, no median, still counted in the window', () => {
  const now = T0;
  const t = (i, cost, by) => ({ status: 'done', agent: 'claude', endedAt: now - 1000 - i, by, stats: { costUsd: cost } });
  const s = { id: 's', agent: 'claude', createdAt: 1, turns: [t(0, 5), t(1, 5), t(2, 5), t(3, 5), t(4, 0.7, 'compact'), t(5, 0.7, 'compact'), t(6, 0.7, 'compact')] };
  const budget = { windows: () => [{ id: 'five_hour', used: 0.5, resetsAt: now + H, ms: 5 * H }], rate: () => 0.01, view: () => [], acked: () => null };
  const g = new Guard({ store: { all: () => [s], config: { defaults: {} } }, budget, now: () => now, setting: () => '90' });
  assert.deepEqual(g.units('claude', { kind: 'followUp', session: s }), [5, 5, 5], 'three compacts don\'t drag it down');
  // The window's ceiling still counts them: 20 + 2.1 units in it.
  assert.ok(Math.abs(g.rate('claude', 'default', { id: 'five_hour', used: 0.1, resetsAt: now + H, ms: 5 * H }) - 0.1 / 22.1) < 1e-9);
});

// --- the route -------------------------------------------------------------------------------

test('(c) with the guard over the line: Compact now runs, nothing held, nothing acked; a typed /compact stays refused', async () => {
  const resetsAt = Math.floor((Date.now() + 2 * H) / 1000);
  const FAKE_LIMITS = JSON.stringify({ status: 'allowed', resetsAt, rateLimitType: 'five_hour', utilization: 0.95, unifiedWindows: { five_hour: { utilization: 0.95, resetsAt } } });
  await api('/config', { defaults: { limitHold: '80' } }, 'PATCH');
  try {
    const rec = tmp('compact-rec');
    const s = await warm({ FAKE_LIMITS, FAKE_RECORD: rec });
    await withEnv({ FAKE_LIMITS, FAKE_RECORD: rec }, async () => {
      const typed = await call(`/sessions/${s.id}/reply`, { text: '/compact' });
      assert.equal(typed.status, 409);
      assert.ok(typed.json.hold);
      assert.equal((await api(`/sessions/${s.id}`)).turns.length, 1);
      const acks = JSON.stringify(srv.budget.state.claude.default.acks || {});
      assert.ok((await api('/sessions')).find((x) => x.id === s.id).compactOffer, 'the list says so');
      assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
      const x = await ended(s.id, 2);
      assert.equal(x.turns[1].status, 'done');
      assert.equal(x.turns[1].by, 'compact');
      assert.equal(x.turns[1].held, undefined);
      assert.equal(JSON.stringify(srv.budget.state.claude.default.acks || {}), acks, 'no yes on your behalf');
      assert.equal(taskRuns(rec, 'claude').at(-1).stdin, '/compact');
      assert.equal((await api('/sessions')).find((y) => y.id === s.id).followups, 0, 'not a follow-up of yours');
      assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 409, 'it just shrank: not offered again');
    });
  } finally {
    await api('/config', { defaults: { limitHold: 'off' } }, 'PATCH');
    delete srv.budget.state.claude;
  }
});

test('a used-up window is refused with words, and no run', async () => {
  const resetsAt = Math.floor((Date.now() + 2 * H) / 1000);
  const s = await warm({ FAKE_LIMITS: JSON.stringify({ status: 'allowed', resetsAt, rateLimitType: 'five_hour', utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt } } }) });
  const r = await call(`/sessions/${s.id}/compact`, {});
  delete srv.budget.state.claude;
  assert.equal(r.status, 409);
  assert.match(r.json.error, /used up/);
  assert.equal((await api(`/sessions/${s.id}`)).turns.length, 1);
});

test('too small or past the TTL: 409 with words, no run', async () => {
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(s.id, 1);
  const small = await call(`/sessions/${s.id}/compact`, {});
  assert.equal(small.status, 409);
  assert.match(small.json.error, /can’t be compacted/);
  const big2 = await warm();
  srv.store.get(big2.id).turns[0].endedAt = Date.now() - H;
  assert.equal((await call(`/sessions/${big2.id}/compact`, {})).status, 409);
  assert.equal((await api(`/sessions/${big2.id}`)).turns.length, 1);
});

test('a repo\'s or harness\'s card would hold it: refused, never a held turn', async () => {
  const s = await warm();
  const was = srv.runner.startsHeld;
  srv.runner.startsHeld = () => true;
  try {
    const r = await call(`/sessions/${s.id}/compact`, {});
    assert.equal(r.status, 409);
    assert.equal((await api(`/sessions/${s.id}`)).turns.length, 1);
  } finally {
    srv.runner.startsHeld = was;
  }
});

test('nothing goes in front of /compact: not a handoff, whatever the turns before', async () => {
  const rec = tmp('compact-bare');
  const s = await warm();
  await withEnv({ FAKE_RECORD: rec }, async () => {
    const live = srv.store.get(s.id);
    live.turns.push({ id: 'codex1', agent: 'codex', status: 'done', prompt: 'something else', startedAt: Date.now(), endedAt: Date.now(), activity: [], changes: [], attachments: [], stats: { outputTokens: 40 }, presentation: { blocks: [{ type: 'hero', title: 'Done', status: 'done' }] } });
    assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 409, 'the same-agent rule covers it at the route');
    srv.runner.reply(live, '/compact', [], { by: 'compact' });
    await ended(s.id, 3);
    assert.equal(taskRuns(rec, 'claude').at(-1).stdin, '/compact');
  });
});

test('a goal and a done task stay as they were, and nobody is notified', async () => {
  const rec = tmp('compact-goal');
  const s = await warm();
  const live = srv.store.get(s.id);
  live.state = 'done';
  live.unread = false;
  live.goal = { text: 'it works [met after 9]', status: 'working', round: 1, checks: [], judges: [] };
  const finished = [];
  const onFinished = (f) => finished.push(f);
  srv.runner.on('finished', onFinished);
  try {
    await withEnv({ FAKE_RECORD: rec }, async () => {
      assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
      const x = await until(async () => {
        const y = await api(`/sessions/${s.id}`);
        return y.turns.length === 2 && y.turns[1].status === 'done' && y;
      }, { timeout: 30_000 });
      assert.equal(x.state, 'done');
      assert.equal(x.unread, false);
      assert.equal(live.goal.status, 'working', 'not cancelled, and no check ran');
      assert.deepEqual(records(rec, 'goal'), []);
      assert.deepEqual(finished, []);
    });
  } finally {
    srv.runner.off('finished', onFinished);
    delete live.goal;
  }
});

// Compacts a warm task set up by `from`, and says what it ended as and who was told.
async function compactFrom(from, env = {}) {
  const s = await warm();
  const live = srv.store.get(s.id);
  Object.assign(live, from);
  const finished = [];
  const onFinished = (f) => finished.push(f);
  srv.runner.on('finished', onFinished);
  try {
    await withEnv(env, async () => {
      assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
      await until(async () => (await api(`/sessions/${s.id}`)).turns[1]?.endedAt, { timeout: 30_000 });
    });
    await until(async () => live.state !== 'running' && live.turns[1].status !== 'running', { timeout: 30_000 });
    return { live, finished };
  } finally {
    srv.runner.off('finished', onFinished);
  }
}

test('a task in review stays in review with its unread as it was, and nobody is notified', async () => {
  for (const unread of [true, false]) {
    const { live, finished } = await compactFrom({ state: 'review', unread });
    assert.deepEqual([live.state, live.unread, finished.length], ['review', unread, 0]);
    assert.equal(live.turns[1].was, undefined, 'not kept on the turn');
  }
});

test('an archived task stays archived, a For later one stays For later', async () => {
  const archived = await compactFrom({ state: 'done', unread: false, archived: true });
  assert.deepEqual([archived.live.archived, archived.live.state, archived.live.unread, archived.finished.length], [true, 'done', false, 0]);
  const forLater = { at: Date.now(), by: 'user' };
  const later = await compactFrom({ state: 'review', unread: false, forLater });
  assert.deepEqual([later.live.forLater, later.live.state, later.finished.length], [forLater, 'review', 0]);
});

test('a compact that fails shows like any run, from anywhere', async () => {
  const { live, finished } = await compactFrom({ state: 'done', unread: false, archived: true, forLater: { at: 1, by: 'user' } }, { FAKE_FAIL: '1' });
  assert.equal(live.turns[1].status, 'error');
  assert.equal((await api('/sessions')).find((x) => x.id === live.id).status, 'blocked', 'the row says it failed');
  assert.deepEqual([live.state, live.unread, live.archived, live.forLater, finished.length], ['review', true, undefined, undefined, 1]);
});

test('a usage limit on a compact shows like any run', async () => {
  const hit = '5-hour limit reached ∙ resets 3pm';
  const f = replay([{ type: 'system', subtype: 'init', session_id: 'sess-1' }, { type: 'result', subtype: 'success', is_error: true, result: hit, local_command: 'compact', num_turns: 0, session_id: 'sess-1', usage: {} }]);
  const { live, finished } = await compactFrom({ state: 'done', unread: false }, { FAKE_REPLAY: f });
  assert.equal(live.turns[1].status, 'error');
  assert.ok(live.turns[1].limit, 'the limit card');
  assert.deepEqual([live.state, live.unread, finished.length], ['review', true, 1]);
  delete srv.budget.state.claude;
});

test('a normal turn that auto-compacted on its way keeps its plain-text note and has no stats.compact', async () => {
  const say = (usage, text) => ({ type: 'assistant', session_id: 'sess-mid', message: { id: `m${text}`, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text }] } });
  const meta = lines().find((m) => m.subtype === 'compact_boundary');
  const f = replay([
    { type: 'system', subtype: 'init', session_id: 'sess-mid' },
    say({ input_tokens: 10, cache_read_input_tokens: 480_000, output_tokens: 5 }, 'Working'),
    { ...meta, session_id: 'sess-mid' },
    say({ input_tokens: 30, cache_read_input_tokens: 9000, output_tokens: 5 }, 'Done'),
    { type: 'result', subtype: 'success', is_error: false, result: 'Plain words, no blocks.', num_turns: 3, session_id: 'sess-mid', total_cost_usd: 0.1, usage: { input_tokens: 40, output_tokens: 10 } },
  ]);
  const x = await withEnv({ FAKE_REPLAY: f }, async () => {
    const s = await api('/sessions', { prompt: 'a long job', cwd: makeRepo(), agent: 'claude', worktree: false });
    return ended(s.id, 1);
  });
  const t = x.turns[0];
  assert.equal(t.stats.compact, undefined);
  assert.equal(t.stats.contextTokens, 9030, 'contextTokens as ever');
  assert.equal(t.presentation.fallback, true, 'it answered in plain text: still said so');
  assert.doesNotMatch(JSON.stringify(t.presentation), /Compacted/);
});

test('(d) nothing to compact: the card doesn\'t claim it, the cold line stays, the offer goes', async () => {
  const s = await warm();
  const x = await withEnv({ FAKE_COMPACT: 'none' }, async () => {
    assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
    return ended(s.id, 2);
  });
  const t = x.turns[1];
  assert.equal(t.status, 'done');
  assert.deepEqual(t.stats.compact, { none: true });
  assert.ok(!('contextTokens' in t.stats));
  const words = JSON.stringify(t.presentation);
  assert.match(words, /Not enough messages to compact\./);
  assert.doesNotMatch(words, /Compacted|finished without a message/);
  assert.equal(t.presentation.fallback, undefined);
  const row = (await api('/sessions')).find((y) => y.id === s.id);
  assert.equal(row.status, x.turns[0].presentation.blocks.find((b) => b.type === 'hero').status, 'the row keeps the last answer\'s verdict');
  assert.equal(row.preview, x.turns[0].presentation.blocks.find((b) => b.type === 'hero').summary);
  assert.equal(coldCache(x, Date.now() + 9 * H).cold, true, 'the cold line stays true');
  assert.equal(compactOffer(x), null);
  assert.equal((await api('/sessions')).find((y) => y.id === s.id).compactOffer, undefined);
  assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 409);
});

test('(e) a compact turn, then a resumed one: the right costs, totals carried, receipts, the plan\'s move kept', async () => {
  const resetsAt = Math.floor((Date.now() + 2 * H) / 1000);
  const limits = (u) => JSON.stringify({ status: 'allowed', resetsAt, rateLimitType: 'five_hour', utilization: u, unifiedWindows: { five_hour: { utilization: u, resetsAt } } });
  const s = await warm({ FAKE_LIMITS: limits(0.1) });
  await withEnv({ FAKE_LIMITS: limits(0.12) }, async () => {
    assert.equal((await call(`/sessions/${s.id}/compact`, {})).status, 200);
    await ended(s.id, 2);
  });
  const x = await withEnv({ FAKE_CONTEXT: '1h', FAKE_LIMITS: limits(0.13) }, async () => {
    await api(`/sessions/${s.id}/reply`, { text: 'carry on' });
    return ended(s.id, 3);
  });
  delete srv.budget.state.claude;
  const [first, compact, next] = x.turns;
  assert.equal(compact.stats.costUsd, 0.0071867);
  assert.ok(Math.abs(compact.stats.totals.costUsd - (first.stats.totals.costUsd + 0.0071867)) < 1e-9);
  assert.equal(compact.stats.models.length, 1);
  assert.equal(compact.stats.models[0].cacheRead, 34352);
  assert.equal(compact.stats.contextTokens, 0);
  assert.equal(next.stats.costUsd, 0.0031232, '#602: from the compact turn\'s totals');
  assert.ok(next.stats.totals.costUsd > compact.stats.totals.costUsd);
  assert.ok(next.stats.contextTokens > 0);
  assert.deepEqual(receiptParts(receiptOf(compact)).slice(0, 2), ['61k tokens', '58% cache']);
  assert.match(receiptParts(receiptOf(next))[0], /k tokens$/);
  // Each move is shared out by time among the turns since the last report: none of it gets lost
  // on the compact turn, whose report comes before its status lines.
  assert.ok(compact.plan?.[0]?.used > 0, 'the compact has its part');
  const shared = x.turns.flatMap((t) => t.plan || []).reduce((a, w) => a + w.used, 0);
  assert.ok(Math.abs(shared - 0.03) < 1e-6, `both moves traced (10 to 12 to 13%), got ${shared}`);
});

test('(f) a side discussion: POST /compact refused with no run; a typed /compact stays behind the gate', async () => {
  const rec = tmp('compact-side');
  const s = await warm();
  await withEnv({ FAKE_RECORD: rec }, async () => {
    const side = await api(`/sessions/${s.id}/side`, { text: 'why this?' });
    await ended(side.id, 1);
    const live = srv.store.get(side.id);
    // Warm and large by every other rule: only being a side discussion refuses it.
    Object.assign(live.turns[0], { stats: { ...live.turns[0].stats, contextTokens: 480_000, cacheTtlMs: H } });
    const r = await call(`/sessions/${side.id}/compact`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /side discussion/i);
    assert.equal((await api(`/sessions/${side.id}`)).turns.length, 1);
    await api(`/sessions/${side.id}/reply`, { text: '/compact' });
    await ended(side.id, 2);
    const { argv } = taskRuns(rec, 'claude').at(-1);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default');
    assert.ok(JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions.ask.length, 'the ask rule');
  });
});
