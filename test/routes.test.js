// The route table and openapi.json describe the same API: every public route is documented,
// and every documented operation has a route behind it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
