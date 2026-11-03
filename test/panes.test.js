// Panes (web/js/pane-bridge.js, web/js/features/panes.js, services/stuff.js, services/apps.js): a My
// Stuff app pinned beside tasks or on home. What it may call is what its wisp-app.json "uses" and
// you allowed; anything else is refused before it reaches wisp's API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { installFakeBins, tmp } from './helpers.js';
import { appFor, argsOf, grantOf, lightPrs, lightTask, missingOf, PANE_CALLS, PANE_CLIENT, PANE_USES, panesProblem, panesString, parsePanes, refusal, usesOf } from '../web/js/pane-bridge.js';

process.env.WISP_HOME = tmp('panes-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

test('usesOf: wisp-app.json "uses" is a list of known scopes, deduped', () => {
  assert.deepEqual(usesOf({}), []);
  assert.deepEqual(usesOf({ uses: ['tasks:read', 'tasks:read', 'prs:read'] }), ['tasks:read', 'prs:read']);
  assert.throws(() => usesOf({ uses: 'tasks:read' }), /is a list/);
  assert.throws(() => usesOf({ uses: ['tasks:read', 'files:write'] }), /"files:write" isn't something an app can use/);
});

test('refusal: a call outside what was allowed is refused, and so is one wisp has no name for', () => {
  assert.equal(refusal('tasks.list', ['tasks:read']), '');
  assert.match(refusal('tasks.launch', ['tasks:read']), /Not allowed: tasks\.launch\(\) needs "tasks:write"/);
  assert.match(refusal('tasks.list', []), /needs "tasks:read"/);
  assert.match(refusal('prs.list', ['tasks:read', 'tasks:write']), /needs "prs:read"/);
  assert.match(refusal('crew.list', undefined), /needs "crew:read"/);
  assert.match(refusal('sessions.delete', Object.keys(PANE_USES)), /wisp has no sessions\.delete\(\)/);
  assert.match(refusal('__proto__', Object.keys(PANE_USES)), /wisp has no/);
  for (const [m, need] of Object.entries(PANE_CALLS)) assert.equal(refusal(m, [need]), '', `${m} with ${need}`);
});

test('grants: only what the app asks for, and an update that asks for less shrinks it', () => {
  assert.deepEqual(grantOf(['tasks:read'], ['tasks:read', 'tasks:write', 'tasks:read']), ['tasks:read']);
  assert.deepEqual(grantOf(['tasks:read'], 'tasks:read'), []);
  assert.deepEqual(missingOf({ uses: ['tasks:read', 'prs:read'], allowed: ['tasks:read'] }), ['prs:read']);
  assert.deepEqual(missingOf({}), []);
});

test('argsOf: ids and text are checked and capped before any call', () => {
  assert.match(argsOf('tasks.get', []).error, /needs a task id/);
  assert.match(argsOf('tasks.followUp', ['abc', '  ']).error, /needs a task id and some text/);
  assert.deepEqual(argsOf('tasks.launch', ['Fix the build']).args, [{ prompt: 'Fix the build', project: undefined }]);
  assert.deepEqual(argsOf('tasks.launch', [{ prompt: 'x', project: 'wisp', mode: 'auto', agent: 'codex' }]).args, [{ prompt: 'x', project: 'wisp' }], 'a pane can’t pick the mode or harness');
  assert.equal(argsOf('tasks.followUp', ['abc', 'y'.repeat(50_000)]).args[1].length, 20_000);
});

test('the panes setting: "<app>@task,<app>@home", checked', () => {
  assert.deepEqual(parsePanes('kanban@home, notes@task ,solo'), [
    { app: 'kanban', where: 'home' },
    { app: 'notes', where: 'task' },
    { app: 'solo', where: 'task' },
  ]);
  assert.equal(panesString(parsePanes('a@home,b@task')), 'a@home,b@task');
  assert.equal(panesProblem(''), '');
  assert.equal(panesProblem('kanban@home'), '');
  assert.match(panesProblem('kanban@sidebar'), /should be <app id or name>@task or @home/);
  assert.match(panesProblem(Array.from({ length: 9 }, (_, i) => `a${i}@home`).join(',')), /At most 8/);
  assert.match(panesProblem(3), /is a string/);
  const items = [{ id: 'x1', kind: 'app', name: 'kanban', title: 'Task board' }, { id: 'x2', kind: 'doc', name: 'kanban' }];
  assert.equal(appFor({ app: 'x1' }, items).id, 'x1');
  assert.equal(appFor({ app: 'Task Board' }, items).id, 'x1', 'by title, any case');
  assert.equal(appFor({ app: 'nope' }, items), null);
});

test('light shapes: a task never carries its turns or folder', () => {
  const s = { id: 't1', title: 'Fix', state: 'review', status: 'done', project: 'wisp', cwd: '/secret', turns: [{ prompt: 'p' }], pr: { number: 3, url: 'u', state: 'open', checks: 'pass' }, prs: [{ repo: 'o/r', pr: { number: 4, url: 'u4', state: 'open' } }] };
  const t = lightTask(s);
  assert.equal(t.title, 'Fix');
  assert.equal(t.pr.number, 3);
  assert.ok(!('turns' in t) && !('cwd' in t));
  assert.deepEqual(lightPrs([s, { id: 'w', agent: 'wisp', pr: { url: 'tour' } }]).map((p) => p.number), [3, 4], 'the tour’s left out');
});

test('/_wisp/pane.js: outside a pane every call refuses; inside, calls post to the parent', async () => {
  const run = (inPane) => {
    const posted = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const ctx = { addEventListener() {}, console, Promise, Error, Object, Map };
    ctx.window = ctx;
    ctx.parent = inPane ? parent : ctx;
    vm.runInNewContext(PANE_CLIENT, ctx);
    return { wisp: ctx.wisp, posted };
  };
  const tab = run(false);
  await assert.rejects(tab.wisp.tasks.list(), /Pin this app as a pane/);
  const pane = run(true);
  const plain = (x) => JSON.parse(JSON.stringify(x)); // from the vm's realm
  assert.deepEqual(plain(pane.posted[0]), { wispPane: 1, hello: 1 });
  pane.wisp.tasks.launch({ prompt: 'x' });
  assert.deepEqual(plain(pane.posted[1]), { wispPane: 1, id: 1, method: 'tasks.launch', args: [{ prompt: 'x' }] });
  assert.throws(() => (pane.wisp.tasks = {}), TypeError, 'frozen');
});

// --- the page: panes.js checks each call before it goes to the API -------------------------------

const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });

test('paneCall: refuses what wasn’t allowed before calling anything, and answers light tasks', async () => {
  const calls = [];
  const saved = {};
  for (const k of ['document', 'window', 'matchMedia', 'requestAnimationFrame', 'localStorage', 'addEventListener', 'location', 'history', 'fetch', 'navigator', 'setInterval', 'innerWidth', 'innerHeight']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set('document', new Proxy({}, { get: (t, k) => (k === 'querySelectorAll' ? () => [] : any()) }));
  set('window', globalThis);
  set('matchMedia', () => ({ matches: false, addEventListener() {}, addListener() {} }));
  set('requestAnimationFrame', () => 0);
  set('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  set('addEventListener', () => {});
  set('location', new URL('http://localhost/'));
  set('history', { pushState() {}, replaceState() {}, state: null });
  // Node 20 has no navigator (ui/kbd.js reads it at load).
  set('navigator', { platform: 'MacIntel', userAgent: 'node', clipboard: undefined });
  set('fetch', async (url, o) => {
    calls.push([String(url), o?.method || 'GET']);
    return { ok: true, status: 201, headers: new Map([['content-type', 'application/json']]), json: async () => ({ id: 'n1', title: 'New' }), text: async () => '{}' };
  });
  set('setInterval', () => 0);
  set('innerWidth', 1440);
  set('innerHeight', 900);
  const stubs = ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'].filter((n) => !globalThis[n]);
  for (const n of stubs)
    globalThis[n] = class {
      constructor() {
        return any();
      }
    };
  try {
    const { S } = await import('../web/js/core/state.js');
    const { paneCall } = await import('../web/js/features/panes.js');
    S.config = { defaults: {}, projects: [{ id: 'p1', name: 'wisp', path: '/w' }], crew: [{ id: 'm1', name: 'Ada', role: 'Lead', running: true, memory: 'secret' }] };
    S.stuff = [{ id: 'a1', kind: 'app', title: 'Board', uses: ['tasks:read', 'tasks:write'], allowed: ['tasks:read'] }];
    S.sessions = new Map([['t1', { id: 't1', title: 'Fix', state: 'review', cwd: '/w', project: 'wisp' }]]);
    const f = { id: 'a1', where: 'home', writes: [] };
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }]), /Not allowed: tasks\.launch\(\) needs "tasks:write"/);
    await assert.rejects(paneCall(f, 'crew.list', []), /needs "crew:read"/);
    assert.deepEqual(calls, [], 'nothing reached the API');
    const list = await paneCall(f, 'tasks.list', []);
    assert.deepEqual(list.map((t) => [t.id, t.title, t.cwd]), [['t1', 'Fix', undefined]]);
    await assert.rejects(paneCall(f, 'tasks.get', ['nope']), /No task nope/);

    // Allowed now: a launch goes to POST /sessions with your defaults, at most a few a minute.
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    const out = await paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }]);
    assert.equal(out.id, 'n1');
    assert.deepEqual(calls.at(-1), ['/api/sessions', 'POST']);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'nowhere' }]), /No project nowhere/);
    for (let i = 0; i < 4; i++) await paneCall(f, 'tasks.launch', [{ prompt: `go ${i}` }]);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'one more' }]), /Slow down/);
  } finally {
    for (const n of stubs) delete globalThis[n];
    for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

// --- the server: uses, grants, the bridge script and the CSP -----------------------------------

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
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
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
const appDir = (name, manifest) => {
  const dir = path.join(tmp('pane-app'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Board</title><script src="/_wisp/pane.js"></script>');
  fs.writeFileSync(path.join(dir, 'wisp-app.json'), JSON.stringify(manifest));
  return dir;
};

test('an app that uses wisp: you allow it, only what it asks; it is served with its bridge and a CSP', async () => {
  assert.throws(() => srv.stuff.addApp(appDir('bad', { name: 'Bad', uses: ['shell:run'] })), /isn't something an app can use/);
  const it = srv.stuff.addApp(appDir('board', { name: 'Board', uses: ['tasks:read', 'tasks:write'] }));
  assert.deepEqual(it.uses, ['tasks:read', 'tasks:write']);
  assert.equal(it.allowed, undefined, 'nothing allowed until you do');
  const view = await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'crew:read'] });
  assert.deepEqual(view.allowed, ['tasks:read'], 'only what it asks for');
  assert.deepEqual(view.uses, ['tasks:read', 'tasks:write']);

  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const page = await fetch(url);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const js = await fetch(`${url}_wisp/pane.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(await js.text(), PANE_CLIENT);

  // An update that drops tasks:write keeps tasks:read allowed; dropping uses drops the CSP too.
  srv.stuff.addApp(appDir('board2', { name: 'Board', uses: ['tasks:write'] }), { replace: it.id });
  assert.equal(srv.stuff.get(it.id).allowed, undefined, 'tasks:read is no longer asked for');
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:write'] });
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:write']);
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, undefined, 'DELETE')).allowed, undefined);
  srv.stuff.addApp(appDir('board3', { name: 'Board' }), { replace: it.id });
  const again = await api(`/stuff/${it.id}/launch`, {});
  assert.equal((await fetch(again.url)).headers.get('content-security-policy'), null, 'an app that doesn’t use wisp keeps its network');
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
});

test('PATCH /config checks the panes setting', async () => {
  await assert.rejects(api('/config', { defaults: { panes: 'board@nowhere' } }, 'PATCH'), /@task or @home/);
  const out = await api('/config', { defaults: { panes: 'board@home' } }, 'PATCH');
  assert.equal(out.defaults.panes, 'board@home');
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
});
