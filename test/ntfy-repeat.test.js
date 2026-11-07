// A tap ntfy sends again after a restart acts only once, on a real wisp, across two boots. ntfy
// sends messages of its marker's own second again and leaves dropping them to the client, so what
// was dropped has to outlive the process. A Done would otherwise close a task you reopened since.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, tmp, until, sleep } from './helpers.js';

process.env.FAKE_RECORD = tmp('ntfy-repeat-record');
process.env.WISP_HOME = tmp('ntfy-repeat-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_TELEMETRY = '0';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ntfy's own rule for since=<id>: what's after it, and what's of its second or later but for itself.
const taps = [];
const polls = [];
const ntfy = http.createServer((req, res) => {
  const since = new URL(req.url, 'http://x').searchParams.get('since');
  polls.push(since);
  const at = taps.findIndex((m) => m.id === since);
  const out = /^\d+$/.test(since) ? taps.filter((m) => m.time >= Number(since)) : at < 0 ? taps : taps.filter((m, i) => i > at || (i < at && m.time >= taps[at].time));
  res.writeHead(200);
  res.end(out.map((m) => JSON.stringify(m)).join('\n'));
});
await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
after(() => ntfy.close());
const ntfyUrl = `http://127.0.0.1:${ntfy.address().port}`;

async function boot() {
  const port = await freePort();
  const app = await startServer({ port, handleSignals: false });
  app.remote.ntfyPollMs = 20;
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return r.json();
  };
  return { app, api, stop: () => { app.shutdown(); app.server.closeAllConnections?.(); return new Promise((r) => app.server.close(r)); } };
}

const polled = async (n = 3) => {
  const at = polls.length;
  await until(() => polls.length >= at + n, { what: 'ntfy polls' });
};

test('ntfy: a Done sent again after a restart does not close a task you reopened', async () => {
  const one = await boot();
  await one.api('PUT', '/remote', { ntfy: { enabled: true, server: ntfyUrl, topic: 'wisp-t' } });
  await polled();
  const s = (await one.api('POST', '/sessions', { prompt: 'hello', agent: 'claude', cwd: makeRepo(), mode: 'bypass' }));
  const id = (s.sessions?.[0] || s.session || s).id;
  await until(() => one.app.store.get(id)?.state === 'review', { what: 'the turn to end' });
  const ref = one.app.store.get(id).turns.at(-1).id;

  // Done on this task, and a tap on something else in the same second.
  const time = Math.floor(Date.now() / 1000) + 5;
  const tap = (mid, s, k, r) => taps.push({ id: mid, event: 'message', time, message: JSON.stringify({ s, k, r, i: 0, sig: one.app.remote.sign(s, { d: 'done', a: 'answer' }[k], r, 0) }) });
  tap('m1', id, 'd', ref);
  tap('m2', id, 'a', 'not-asked');
  await until(() => one.app.store.get(id).state === 'done' && polls.at(-1) === 'm2', { what: 'both taps to land' });

  await one.api('PATCH', `/sessions/${id}`, { state: 'review' }); // Reopen, in wisp
  assert.equal(one.app.store.get(id).state, 'review');
  await one.stop();

  const two = await boot();
  two.app.remote.ntfyPollMs = 20;
  await polled(6);
  assert.equal(two.app.store.get(id).state, 'review', 'the Done from before the restart acted again');
  await two.stop();
});
