// The route table and openapi.json describe the same API: every public route is documented,
// and every documented operation has a route behind it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { installFakeBins, tmp, isolateAgentConfigs } from './helpers.js';

process.env.WISP_HOME = tmp('routes-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();
const { startServer } = await import('../server/index.js');

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
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

// '/sessions/:id' and '/sessions/{id}' both become '/sessions/{}'.
const shape = (p) => p.replace(/:\w+/g, '{}').replace(/\{\w+\}/g, '{}');

test('every public route is in openapi.json, and every documented operation is routed', async () => {
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  const documented = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) if (m !== 'parameters') documented.add(`${m.toUpperCase()} ${shape(p)}`);
  const routes = srv.routes.list();
  const routed = new Set(routes.map((r) => `${r.method} ${shape(r.pattern)}`));
  const undocumented = routes.filter((r) => r.doc && !documented.has(`${r.method} ${shape(r.pattern)}`)).map((r) => `${r.method} ${r.pattern}`);
  const unrouted = [...documented].filter((k) => !routed.has(k));
  assert.deepEqual(undocumented, [], 'routes missing from openapi.json (document them, or mark them doc: false)');
  assert.deepEqual(unrouted, [], 'documented operations with no route');
});

// A desktop's side of API keys (services/api-keys.js); the cloud wisp's is in grid.test.js. A stand-in
// for the grid, which is what keeps them.
test('/cloud/keys: asks the grid you’re signed in to, keeps nothing, and says why it can’t', async () => {
  const api = async (p, { method = 'GET', body, headers } = {}) => {
    const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json(), store: r.headers.get('cache-control') };
  };
  // No grid: nothing to show, and nothing to write to.
  const none = await api('/cloud/keys');
  assert.deepEqual([none.status, none.json, none.store], [200, { grid: null, keys: [] }, 'no-store']);
  for (const [method, p] of [['POST', '/cloud/keys'], ['DELETE', '/cloud/keys/abc123']]) {
    const r = await api(p, { method, body: { name: 'x' } });
    assert.equal(r.status, 409, p);
    assert.match(r.json.error, /Sign in to a wisp Grid first/);
    assert.equal(r.store, 'no-store');
  }

  const key = 'wgk_only-the-page-gets-this';
  const seen = [];
  let answer = null; // a stand-in for what an older grid would say
  const fake = http.createServer((req, res) => {
    let t = '';
    req.on('data', (d) => (t += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: t });
      const send = (s, o) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (answer) return send(...answer);
      const row = { id: 'abc123', name: 'Deploy', hint: 'this', createdAt: 1, lastUsedAt: null };
      if (req.method === 'GET') return send(200, { keys: [row] });
      if (req.method === 'POST') return JSON.parse(t).name ? send(201, { ...row, key }) : send(400, { error: 'Give the key a name.' });
      return req.url.endsWith('/abc123') ? send(200, { ok: true }) : send(404, { error: 'No such key.' });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const grid = `http://127.0.0.1:${fake.address().port}`;
  const m = srv.machines.addGrid({ url: 'http://kai.grid.localhost', grid, handle: 'kai', name: 'Cloud', token: 'wgd_device' });
  try {
    const list = await api('/cloud/keys');
    assert.deepEqual(list.json, { grid: { host: new URL(grid).host, handle: 'kai' }, keys: [{ id: 'abc123', name: 'Deploy', hint: 'this', createdAt: 1, lastUsedAt: null }] });
    assert.deepEqual([seen.at(-1).url, seen.at(-1).auth], ['/api/keys', 'Bearer wgd_device']);
    const made = await api('/cloud/keys', { method: 'POST', body: { name: 'Deploy' } });
    assert.deepEqual([made.status, made.json.key, made.store], [201, key, 'no-store']);
    assert.equal(JSON.parse(seen.at(-1).body).name, 'Deploy');
    assert.deepEqual([(await api('/cloud/keys', { method: 'POST', body: {} })).status, (await api('/cloud/keys', { method: 'POST', body: {} })).json.error], [400, 'Give the key a name.']);
    assert.deepEqual((await api('/cloud/keys/abc123', { method: 'DELETE', body: {} })).json, { ok: true });
    assert.equal(seen.at(-1).url, '/api/keys/abc123');
    const missing = await api('/cloud/keys/fff', { method: 'DELETE', body: {} });
    assert.deepEqual([missing.status, missing.json.error], [404, 'No such key.']);
    const asked = seen.length;
    assert.equal((await api('/cloud/keys/not-hex', { method: 'DELETE', body: {} })).status, 404);
    assert.equal(seen.length, asked, 'never sent on');
    // Here there's no proxy: the header means nothing, and a desktop's local requests are its own.
    assert.equal((await api('/cloud/keys', { headers: { 'x-wisp-proxy-via': 'key' } })).status, 200);
    // Nothing kept here.
    for (const f of ['config.json', 'secrets.json']) assert.ok(!fs.readFileSync(path.join(process.env.WISP_HOME, f), 'utf8').includes(key), f);

    answer = [404, { error: 'not found' }];
    const older = await api('/cloud/keys');
    assert.equal(older.status, 409);
    assert.match(older.json.error, /doesn’t make API keys yet \(its wisp Grid is older\)/);
    answer = [401, { error: 'Sign in again.' }];
    assert.equal((await api('/cloud/keys')).status, 409);
    answer = [500, {}];
    assert.equal((await api('/cloud/keys')).status, 502);
    answer = null;
    await new Promise((r) => fake.close(r));
    fake.closeAllConnections?.();
    const down = await api('/cloud/keys');
    assert.equal(down.status, 502);
    assert.match(down.json.error, /^Couldn’t reach 127\.0\.0\.1/);
  } finally {
    srv.machines.remove(m.id);
    fake.close();
  }
  assert.deepEqual((await api('/cloud/keys')).json, { grid: null, keys: [] });
});

// A cloud wisp's Box secret is readable by anything on the box, so it never makes keys: only a
// device sign-in is spoken for (a cloud wisp signed in to another grid).
test('/cloud/keys: a box target isn’t used', async () => {
  const { createApiKeys } = await import('../server/services/api-keys.js');
  const seen = [];
  const fake = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"keys":[]}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const grid = `http://127.0.0.1:${fake.address().port}`;
  const env = { WISP_GRID_URL: 'http://grid.localhost', WISP_TRUSTED_PROXY_SECRET: 's'.repeat(40), WISP_PUBLIC_URL: 'http://kai.grid.localhost' };
  try {
    const alone = createApiKeys({ machines: { list: [] } }, { env });
    assert.deepEqual(await alone.list(), { grid: null, keys: [] });
    await assert.rejects(async () => alone.create('x'), (e) => e.status === 409 && /Sign in to a wisp Grid first/.test(e.message));
    await assert.rejects(async () => alone.revoke('abc123'), (e) => e.status === 409);
    assert.deepEqual(seen, [], 'the grid was never asked');

    // Signed in to another grid: its device token, never the Box secret.
    const other = { machines: { list: [{ id: 'm1', kind: 'grid', grid, handle: 'elsewhere' }] }, secrets: { get: () => 'wgd_device' } };
    assert.equal((await createApiKeys(other, { env }).list()).grid.handle, 'elsewhere');
    assert.deepEqual(seen, ['Bearer wgd_device']);

    // There a key must still be refused, and only when the edge says so.
    const guard = (via) => createApiKeys({ ...other, proxy: { via: () => via } }, { env }).guard({ headers: { 'x-wisp-proxy-via': 'key' } });
    assert.throws(() => guard(true), (e) => e.status === 403 && e.message === 'An API key can’t manage API keys.');
    assert.doesNotThrow(() => guard(false));
  } finally {
    fake.close();
  }
});

test('openapi says how a cloud wisp is scripted, and who the /cloud/keys routes are for', async () => {
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  assert.match(spec.info.description, /A cloud wisp takes scripts at https:\/\/<handle>\.<domain>\/api\/… with Authorization: Bearer wgk_…, an API key made in Settings\./);
  for (const op of [spec.paths['/cloud/keys'].get, spec.paths['/cloud/keys'].post, spec.paths['/cloud/keys/{kid}'].delete]) assert.match(op.summary, /^For a desktop signed in to a wisp Grid: .*on a cloud wisp, keys are (made|managed) in Settings, by the browser at the edge/);
});

test('unknown API paths and methods are 404s with a JSON error', async () => {
  for (const [method, p] of [['GET', '/nope'], ['DELETE', '/health'], ['GET', '/sessions/abc/nope']]) {
    const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.ok((await r.json()).error);
  }
});

test('the web UI is served', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<!doctype html>/i);
  const r = await fetch(`${base}/js/blocks.js`);
  assert.match(r.headers.get('content-type'), /javascript/);
});

test('idle connections outlive the client keep-alive, so reused sockets are not reset mid-request', () => {
  // Node's fetch drops idle sockets after 4s; the server must not close them first.
  assert.ok(srv.server.keepAliveTimeout > 10_000);
  assert.ok(srv.server.headersTimeout > srv.server.keepAliveTimeout);
});

test('a JSON body over the size cap is refused with 413', async () => {
  const r = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2_100_000) }) });
  assert.equal(r.status, 413);
});

test('POST /agents/install refuses a harness wisp cannot install, before touching npm', async () => {
  const r = await fetch(`${base}/api/agents/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'claude' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /can’t install claude/);
});

test('Full auto is the default mode; a saved Edits switches once, Plan sticks', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { Store } = await import('../server/store.js');
  assert.equal(new Store(tmp('mode-fresh')).config.defaults.mode, 'auto');
  const home = (mode) => {
    const h = tmp(`mode-${mode}`);
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ autoIntroduced: true, defaults: { agent: 'claude', mode } }));
    return h;
  };
  const edits = new Store(home('edits'));
  assert.equal(edits.config.defaults.mode, 'auto');
  edits.config.defaults.mode = 'edits';
  edits.saveConfig();
  assert.equal(new Store(edits.home).config.defaults.mode, 'edits', 'picked after the switch: kept');
  assert.equal(new Store(home('plan')).config.defaults.mode, 'plan');
});

test('the layout switch is gone: a saved view (feed or split) is dropped on load', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { Store } = await import('../server/store.js');
  assert.equal(new Store(tmp('view-fresh')).config.defaults.view, undefined);
  for (const view of ['feed', 'split']) {
    const h = tmp(`view-${view}`);
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ autoIntroduced: true, fullAutoIntroduced: true, defaults: { agent: 'claude', mode: 'auto', view } }));
    assert.equal(new Store(h).config.defaults.view, undefined, view);
  }
});

test('a scratch launch runs in its own empty folder, without a project or worktree', async () => {
  // A project that contains the scratch folder (like one at ~) must not claim the task.
  const home = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: process.env.WISP_HOME }) });
  assert.equal(home.status, 201);
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'what is a monad?', scratch: true }) });
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.equal(s.scratch, true);
  assert.equal(s.project, 'General');
  assert.match(s.cwd, /scratch/);
  assert.equal(s.projectId, null);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.ok(!cfg.projects.some((p) => p.path === s.cwd));
});

test('take over trusts the folders wisp made, so the interactive CLI does not stop to ask', async () => {
  const claudeJson = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
  const post = (body) => fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const settled = async (id) => {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${base}/api/sessions/${id}/takeover`);
      if (r.status === 200) return (await r.json()).command;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error(`${id} never became resumable`);
  };
  const scratch = await post({ prompt: 'what is a monad?', scratch: true, agent: 'claude' });
  const own = tmp('own-folder');
  const mine = await post({ prompt: 'look here', cwd: own, agent: 'claude', worktree: false });
  await settled(scratch.id);
  await settled(mine.id);
  const { projects } = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  assert.equal(projects[fs.realpathSync(scratch.cwd)]?.hasTrustDialogAccepted, true, 'the scratch folder');
  assert.equal(projects[fs.realpathSync(own)]?.hasTrustDialogAccepted, undefined, "the user's own folder keeps claude's question");
});

test('deleting a scratch task deletes its scratch folder', async () => {
  const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'draft a haiku', scratch: true }) })).json();
  assert.ok(fs.existsSync(s.cwd));
  const r = await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(s.cwd));
});

test('the update channel is a setting: stable, beta or nightly, and /update says which one is in effect', async () => {
  const patch = (defaults) => fetch(`${base}/api/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaults }) });
  const bad = await patch({ updateChannel: 'canary' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /updateChannel must be one of stable, beta, nightly/);
  assert.equal((await patch({ updateChannel: 'nightly' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).defaults.updateChannel, 'nightly');
  const u = await (await fetch(`${base}/api/update`)).json();
  assert.equal(u.enabled, false); // WISP_UPDATE_CHECK=0: nothing is fetched
  assert.equal(u.channel, 'nightly');
  await patch({ updateChannel: 'stable' });
});
