// Feedback for the wisp team: thumbs on a turn and written notes go to PostHog as 'turn_rated' /
// 'feedback' events, even with usage stats off, and wait in an outbox when offline.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tmp } from './helpers.js';

process.env.WISP_HOME = tmp('feedback-home');
process.env.WISP_UPDATE_CHECK = '0';

const { Telemetry } = await import('../server/telemetry.js');
const { startServer } = await import('../server/index.js');

// Feedback is off in tests (helpers.js); these turn it on around a stubbed PostHog.
const withFeedback = async (fn) => {
  process.env.WISP_FEEDBACK = '1';
  try {
    return await fn();
  } finally {
    process.env.WISP_FEEDBACK = '0';
  }
};
const fakeStore = (defaults = {}) => ({ home: tmp('feedback-store'), config: { defaults, telemetryId: 'install-id' }, saveConfig() {} });

test('feedback goes out with usage stats off, under a one-off id, home dir scrubbed', async () => {
  const sent = [];
  const t = new Telemetry(fakeStore({ telemetry: 'off' }), { post: async (b) => (sent.push(b), true) });
  t.persist();
  const ok = await withFeedback(() => t.feedback('feedback', { text: `broke in ${os.homedir()}/code/app`, rating: 'down' }));
  assert.equal(ok, true);
  const [ev] = sent[0];
  assert.equal(ev.event, 'feedback');
  assert.equal(ev.properties.rating, 'down');
  assert.equal(ev.properties.text, 'broke in ~/code/app');
  assert.notEqual(ev.properties.distinct_id, 'install-id'); // not tied to the analytics id
  assert.ok(ev.properties.version);
});

test('WISP_FEEDBACK=0 sends nothing', async () => {
  const sent = [];
  const t = new Telemetry(fakeStore(), { post: async (b) => (sent.push(b), true) });
  t.persist();
  assert.equal(await t.feedback('feedback', { text: 'hi' }), false);
  assert.equal(sent.length, 0);
});

test('offline feedback waits in the outbox and goes with the next one', async () => {
  const store = fakeStore();
  let online = false;
  const sent = [];
  const t = new Telemetry(store, { post: async (b) => (online && sent.push(b), online) });
  t.persist();
  await withFeedback(async () => {
    assert.equal(await t.feedback('feedback', { text: 'first' }), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(store.home, 'feedback-outbox.json'), 'utf8')).length, 1);
    online = true;
    assert.equal(await t.feedback('feedback', { text: 'second' }), true);
  });
  assert.deepEqual(sent[0].map((e) => e.properties.text), ['first', 'second']);
  assert.equal(fs.existsSync(path.join(store.home, 'feedback-outbox.json')), false);
});

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(p, body) {
  const r = await fetch(`${base}/api${p}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

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

test('/api/feedback: thumbs stick to the turn and carry the run, not the prompt', async () => {
  const sent = [];
  srv.telemetry.post = async (b) => (sent.push(...b), true);
  const [tour] = (await call('/sessions')).body;
  const turn = (await call(`/sessions/${tour.id}`)).body.turns.at(-1);

  const r = await withFeedback(() => call('/feedback', { rating: 'down', sessionId: tour.id, turnId: turn.id, source: 'turn' }));
  assert.deepEqual(r.body, { ok: true, sent: true, available: true });
  assert.equal((await call(`/sessions/${tour.id}`)).body.turns.at(-1).feedback.rating, 'down');
  const ev = sent.at(-1);
  assert.equal(ev.event, 'turn_rated');
  assert.equal(ev.properties.rating, 'down');
  assert.equal(ev.properties.agent, 'wisp');
  assert.equal(ev.properties.tour, true);
  assert.ok(Array.isArray(ev.properties.blockTypes));
  assert.ok(!JSON.stringify(ev).includes(turn.prompt), 'the prompt never leaves');

  // A note after 👎 is a 'feedback' event; clicking the thumb again takes the rating back.
  await withFeedback(() => call('/feedback', { rating: 'down', text: 'diff was empty', sessionId: tour.id, turnId: turn.id }));
  assert.equal(sent.at(-1).event, 'feedback');
  assert.equal(sent.at(-1).properties.text, 'diff was empty');
  await withFeedback(() => call('/feedback', { rating: null, sessionId: tour.id, turnId: turn.id }));
  assert.equal((await call(`/sessions/${tour.id}`)).body.turns.at(-1).feedback, undefined);
});

test('/api/feedback: /feedback text and the dialog rating stay off the turn', async () => {
  const sent = [];
  srv.telemetry.post = async (b) => (sent.push(...b), true);
  const [tour] = (await call('/sessions')).body;
  await withFeedback(() => call('/feedback', { text: 'love it', rating: 'up', sessionId: tour.id, source: 'dialog' }));
  assert.equal(sent.at(-1).event, 'feedback');
  assert.equal(sent.at(-1).properties.source, 'dialog');
  assert.equal((await call(`/sessions/${tour.id}`)).body.turns.at(-1).feedback, undefined);
});

test('/api/feedback: refuses empty notes and bad ratings; reports when feedback is off', async () => {
  assert.equal((await call('/feedback', {})).status, 400);
  assert.equal((await call('/feedback', { rating: 'meh' })).status, 400);
  assert.equal((await call('/feedback', { text: 'x', sessionId: 'nope' })).status, 404);
  assert.deepEqual((await call('/feedback', { text: 'hello' })).body, { ok: true, sent: false, available: false });
  assert.equal((await call('/config')).body.feedback, false);
});

test('page events: only the listed ones, with only their allowed values', async () => {
  const { pageEvent } = await import('../server/telemetry.js');
  assert.deepEqual(pageEvent('getapp_opened', { from: 'button', email: 'a@b.c' }), { from: 'button' });
  assert.deepEqual(pageEvent('getapp_opened', { from: '/Users/me/secret' }), {});
  assert.deepEqual(pageEvent('getapp_clicked', { anything: 'x' }), {});
  assert.equal(pageEvent('prompt_typed', { text: 'hi' }), null);
  assert.equal(pageEvent('__proto__'), null);
  // The route takes them, and says nothing went out while usage stats are off (tests).
  const sent = [];
  srv.telemetry.post = async (b) => (sent.push(...b), true);
  assert.deepEqual((await call('/telemetry/event', { event: 'getapp_hidden' })).body, { ok: true, tracked: false });
  assert.deepEqual((await call('/telemetry/event', { event: 'nope' })).body, { ok: true, tracked: false });
  await srv.telemetry.flush();
  assert.equal(sent.length, 0);
});
