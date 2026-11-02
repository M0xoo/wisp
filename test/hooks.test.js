// Triggers started from outside (server/hooks.js): a trigger's secret URL, POST /api/hooks/<token>,
// for a plain webhook (its body fills the prompt, optionally signed), Slack's Events API and
// Linear's webhooks. Off unless Settings → Automations → Webhook triggers is on.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { installFakeBins, makeClone, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('hooks-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { render, dump, hmacOk, slackOk } = await import('../server/hooks.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let port;
let repo;
async function api(p, { method, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
// As Slack or Linear would call it: the raw bytes, any Host (a tunnel's), no Origin rules.
function call(token, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw));
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/hooks/${token}`, headers: { host: 'wisp-demo.trycloudflare.com', 'content-type': 'application/json', 'content-length': data.length, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');
const trigger = async (id) => (await api('/triggers')).find((t) => t.id === id);
const started = (id) => until(async () => (await trigger(id)).deliveries?.find((d) => d.session)?.session, { what: 'a task from the hook' });

before(async () => {
  port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  repo = makeClone();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('render and the signature checks, on their own', () => {
  assert.equal(render('Deploy {{body.service}} at {{ body.ref.sha }} for {issue}', { body: { service: 'api', ref: { sha: 'abc' } } }, { issue: '#4' }), 'Deploy api at abc for #4');
  assert.equal(render('{{body.items.1.name}}|{{body.nope.x}}|{{body.ref}}', { body: { items: [{ name: 'a' }, { name: 'b' }], ref: { a: 1 } } }), 'b||{"a":1}');
  // What came from outside isn't filled again: a {param} inside it stays as written.
  assert.equal(render('{{text}}', { text: 'say {issue} and {{body.x}}' }, { issue: '#4' }), 'say {issue} and {{body.x}}');
  assert.equal(dump('x'.repeat(5000)).length, 4002);
  assert.equal(hmacOk('s', Buffer.from('{}'), `sha256=${sign('s', '{}')}`), true);
  assert.equal(hmacOk('s', Buffer.from('{}'), sign('s', '{}').toUpperCase()), true, 'hex in either case');
  assert.equal(hmacOk('s', Buffer.from('{}'), sign('t', '{}')), false);
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  assert.equal(slackOk('s', Buffer.from('b'), { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': `v0=${sign('s', `v0:${ts}:b`)}` }, now), '');
  assert.match(slackOk('s', Buffer.from('b'), { 'x-slack-request-timestamp': String(ts - 400), 'x-slack-signature': `v0=${sign('s', `v0:${ts - 400}:b`)}` }, now), /5 minutes/);
});

test('webhook: off by default (404), then its body fills the prompt; one task per 30 s; the secret never comes back', async () => {
  const t = await api('/triggers', { body: { kind: 'webhook', cwd: repo.dir, agent: 'claude', prompt: 'Deploy {{body.service}} at {{body.ref.sha}}.\n\n{{text}}' } });
  assert.equal(t.mode, 'plan', 'outside input starts in plan mode');
  assert.match(t.token, /^[\w-]{32}$/);
  assert.equal((await call(t.token, { service: 'api' })).status, 404, 'Webhook triggers is off');
  await assert.rejects(api('/config', { method: 'PATCH', body: { defaults: { webhookTriggers: 'yes' } } }), (e) => e.status === 400);
  await api('/config', { method: 'PATCH', body: { defaults: { webhookTriggers: 'on' } } });
  assert.equal((await call('nope-nope-nope-nope-nope-nope', {})).status, 404, 'an unknown token');
  const r = await call(t.token, { service: 'api', ref: { sha: 'abc123' } });
  assert.equal(r.status, 202);
  const id = await started(t.id);
  const s = await api(`/sessions/${id}`);
  assert.match(s.turns[0].prompt, /^Deploy api at abc123\./);
  assert.match(s.turns[0].prompt, /"service": "api"/, '{{text}}: the body laid out');
  assert.equal(s.origin?.kind, 'trigger');
  // Another one at once: recorded, not started.
  const again = await call(t.token, { service: 'web' });
  assert.equal(again.status, 429);
  const after = await trigger(t.id);
  assert.deepEqual(after.deliveries.map((d) => d.result), ['skipped', 'started']);
  assert.match(after.deliveries[0].why, /30 s/);
  // A form body works too; Regenerate makes a new URL and the old one stops.
  const fresh = await api(`/triggers/${t.id}`, { method: 'PATCH', body: { regenerate: true } });
  assert.notEqual(fresh.token, t.token);
  assert.equal((await call(t.token, 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 404);
  // Run now has nothing to run.
  await assert.rejects(api(`/triggers/${t.id}/run`, { body: {} }), (e) => e.status === 409);
});

test('webhook with a secret: no signature or a wrong one is 401, a good one (sha256= or bare hex) starts it', async () => {
  const t = await api('/triggers', { body: { kind: 'webhook', cwd: repo.dir, agent: 'claude', secret: 'shh', header: 'X-Signature', prompt: 'Build {{body.ref}}' } });
  assert.equal(t.hasSecret, true);
  assert.equal(t.secret, undefined, 'the secret stays on the server');
  const raw = JSON.stringify({ ref: 'main' });
  assert.equal((await call(t.token, raw)).status, 401);
  assert.equal((await call(t.token, raw, { 'x-signature': sign('nope', raw) })).status, 401);
  assert.equal((await call(t.token, raw, { 'x-signature': `sha256=${sign('shh', raw)}` })).status, 202);
  const id = await started(t.id);
  assert.equal((await api(`/sessions/${id}`)).turns[0].prompt, 'Build main');
  const d = (await trigger(t.id)).deliveries;
  assert.deepEqual(d.map((x) => x.result), ['started', 'rejected', 'rejected']);
  assert.match(d[2].why, /Missing the X-Signature header/);
  // Saving without a secret keeps it; null clears it.
  assert.equal((await api(`/triggers/${t.id}`, { method: 'PATCH', body: { name: 'Builds' } })).hasSecret, true);
  assert.equal((await api(`/triggers/${t.id}`, { method: 'PATCH', body: { secret: null } })).hasSecret, false);
});

test('slack: url_verification, the signature and its 5-minute window, one channel, a keyword', async () => {
  await assert.rejects(api('/triggers', { body: { kind: 'slack', cwd: repo.dir, channel: 'C0123456' } }), (e) => e.status === 400 && /signing secret/.test(e.message));
  await assert.rejects(api('/triggers', { body: { kind: 'slack', cwd: repo.dir, secret: 'x', channel: '#general' } }), (e) => e.status === 400 && /channel’s ID/.test(e.message));
  const t = await api('/triggers', { body: { kind: 'slack', cwd: repo.dir, agent: 'claude', secret: 'slack-secret', channel: 'C0123456', keyword: 'fix' } });
  const signed = (body, ts = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(body);
    return [raw, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': `v0=${sign('slack-secret', `v0:${ts}:${raw}`)}` }];
  };
  const v = await call(t.token, ...signed({ type: 'url_verification', challenge: 'ch4ll' }));
  assert.deepEqual([v.status, v.json], [200, { challenge: 'ch4ll' }]);
  const [raw, h] = signed({ type: 'url_verification', challenge: 'x' });
  assert.equal((await call(t.token, raw, { ...h, 'x-slack-signature': 'v0=00' })).status, 401, 'a wrong signature');
  assert.equal((await call(t.token, ...signed({ type: 'url_verification', challenge: 'x' }, Math.floor(Date.now() / 1000) - 6 * 60))).status, 401, 'a replay from 6 minutes ago');
  const ev = (event) => ({ type: 'event_callback', event_id: `Ev${Math.random()}`, event: { type: 'app_mention', user: 'U42', ts: String(Date.now()), ...event } });
  const other = await call(t.token, ...signed(ev({ channel: 'C9999999', text: '<@U1> fix it' })));
  assert.match(other.json.skipped, /Another channel/);
  assert.match((await call(t.token, ...signed(ev({ channel: 'C0123456', text: '<@U1> hello' })))).json.skipped, /No “fix”/);
  assert.equal((await call(t.token, ...signed(ev({ channel: 'C0123456', text: '<@U1> please fix the login page' })))).status, 202);
  const id = await started(t.id);
  assert.match((await api(`/sessions/${id}`)).turns[0].prompt, /Asked in Slack by <@U42> in <#C0123456>:\n\n<message>\nplease fix the login page\n<\/message>/);
});

test('linear: Linear-Signature over the raw body, an issue created, a label filter', async () => {
  const t = await api('/triggers', { body: { kind: 'linear', cwd: repo.dir, agent: 'claude', secret: 'lin', label: 'Bug', prompt: '{{title}} ({{url}})\n{{description}}' } });
  const send = (body, secret = 'lin') => {
    const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...body });
    return call(t.token, raw, { 'linear-signature': sign(secret, raw) });
  };
  const issue = (labels) => ({ type: 'Issue', action: 'create', data: { id: `i${labels.length}`, title: 'Login loops', url: 'https://linear.app/x/issue/ENG-1', description: 'After a refresh', labels: labels.map((name) => ({ name })) } });
  assert.equal((await send(issue(['bug']), 'wrong')).status, 401);
  assert.match((await send({ type: 'Issue', action: 'update', data: {} })).json.skipped, /not an issue created/);
  assert.match((await send(issue(['feature']))).json.skipped, /No “Bug” label/);
  assert.equal((await send(issue(['bug', 'p1']))).status, 202);
  const id = await started(t.id);
  assert.equal((await api(`/sessions/${id}`)).turns[0].prompt, 'Login loops (https://linear.app/x/issue/ENG-1)\nAfter a refresh');
});

test('hmacOk: GitHub’s sha256=, Sentry’s hex, PagerDuty’s v1= list', async () => {
  const { hmacOk } = await import('../server/hooks.js');
  const { createHmac } = await import('node:crypto');
  const raw = Buffer.from('{"a":1}');
  const hex = createHmac('sha256', 's3').update(raw).digest('hex');
  assert.ok(hmacOk('s3', raw, hex));
  assert.ok(hmacOk('s3', raw, `sha256=${hex}`));
  assert.ok(hmacOk('s3', raw, `v1=deadbeef,v1=${hex}`), 'PagerDuty during a rotation');
  assert.ok(!hmacOk('s3', raw, 'v1=deadbeef'));
});
