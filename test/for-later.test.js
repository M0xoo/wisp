// For later (design/for-later.md): finished tasks parked to look at again. PATCH forLater, what
// takes a task out (done, reopen, archive, a new turn, a reminder), and what it refuses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('forlater-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.FAKE_RECORD = tmp('forlater-rec');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { isForLater, needsYou } = await import('../web/js/core/state.js');

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
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const patch = (id, body) => api(`/sessions/${id}`, body, 'PATCH');
const ended = (id, turns = 1) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length >= turns && x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && !srv.runner.live.has(id) && x;
  });
const task = async () => {
  const s = await api('/sessions', { prompt: 'look at math.js', cwd: makeRepo(), agent: 'claude', worktree: false });
  return ended(s.id);
};

test('Save for later parks a finished task; Mark done, Reopen and Archive take it out', async () => {
  const s = await task();
  assert.equal(s.state, 'review');
  const saved = await patch(s.id, { forLater: true });
  assert.equal(saved.forLater.by, 'user');
  assert.ok(Math.abs(saved.forLater.at - Date.now()) < 5000);
  assert.equal(saved.state, 'review', 'its state and verdict stay');
  assert.equal(saved.unread, true, 'and so does unread');
  assert.equal((await patch(s.id, { forLater: false })).forLater, undefined);

  await patch(s.id, { forLater: true });
  assert.equal((await patch(s.id, { state: 'done' })).forLater, undefined, 'Mark done');
  await patch(s.id, { forLater: true });
  assert.equal((await patch(s.id, { state: 'review' })).forLater, undefined, 'Reopen');
  // Undo after Mark done: the state and its old place in For later, in one request.
  const at = Date.now() - 3600_000;
  const back = await patch(s.id, { state: 'review', forLater: at });
  assert.equal(back.forLater.at, at);
  assert.ok((await patch(s.id, { forLater: Date.now() + 86400_000 })).forLater.at <= Date.now(), 'never in the future');
  assert.equal((await patch(s.id, { archived: true })).forLater, undefined, 'Archive');
  assert.equal((await patch(s.id, { archived: false, forLater: true })).forLater.by, 'user');
});

test('a task still working can’t be saved for later, and new work takes one out', async () => {
  const s = await task();
  srv.store.get(s.id).state = 'running';
  await assert.rejects(patch(s.id, { forLater: true }), (e) => e.status === 409 && /Still working/.test(e.message));
  srv.store.get(s.id).state = 'review';
  await patch(s.id, { forLater: true });
  await api(`/sessions/${s.id}/reply`, { text: 'one more thing' });
  const again = await ended(s.id, 2);
  assert.equal(again.forLater, undefined);
  assert.equal(again.state, 'review', 'it lands in Needs you as usual');
});

test('a reminder that comes due brings it back out of For later', async () => {
  const s = await task();
  await patch(s.id, { forLater: true });
  await api(`/sessions/${s.id}/later`, { in: 5, text: 'look again', remind: true });
  const x = srv.store.get(s.id);
  x.later[0].at = Date.now() - 1000;
  await srv.later.tick();
  assert.ok(x.reminder);
  assert.equal(x.forLater, undefined);
});

test('the page: For later hides nothing that needs you, and isn’t counted as needing you', () => {
  const base = { state: 'review', unread: true, forLater: { at: 1, by: 'user' } };
  assert.equal(isForLater(base), true);
  assert.equal(needsYou(base), false);
  assert.equal(isForLater({ ...base, state: 'running' }), false);
  assert.equal(isForLater({ ...base, state: 'waiting' }), false);
  assert.equal(isForLater({ ...base, reminder: { text: 'x' } }), false);
  assert.equal(isForLater({ ...base, archived: true }), false);
  assert.equal(isForLater({ ...base, state: 'done' }), true);
  assert.equal(needsYou({ state: 'review', unread: true }), true);
  assert.equal(needsYou({ state: 'waiting' }), true);
  assert.equal(needsYou({ state: 'review', unread: false }), false);
});
