// Panes (web/js/pane-bridge.js, web/js/features/panes.js, services/stuff.js, services/apps.js): a My
// Stuff app pinned beside tasks or on home. What it may call is what its wisp-app.json "uses" and
// you allowed; anything else is refused before it reaches wisp's API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { installFakeBins, tmp } from './helpers.js';
import { appFor, argsOf, effectiveGrant, grantOf, launchBody, lightPrs, lightTask, missingOf, notWhile, PANE_APP_CSP, PANE_CALLS, PANE_CLIENT, PANE_CSP, PANE_USES, PANE_WRITES, paneFrameCsp, panesProblem, panesString, paneWrapperDoc, parsePanes, refusal, runsFullAuto, scrubSecrets, showInvisible, usesOf } from '../web/js/pane-bridge.js';
import { appHash, scanApp } from '../server/services/stuff.js';
import { createPublish } from '../server/services/publish.js';
import { packAttached } from '../server/services/share.js';

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

test('launchBody: a pane’s task runs on your New task defaults, never on the server’s fallback', () => {
  const d = { agent: 'codex', mode: 'plan', model: 'm1', effort: 'high', account: 'work' };
  assert.deepEqual(launchBody(d, 'go', { path: '/w' }), { prompt: 'go', cwd: '/w', agent: 'codex', mode: 'plan', model: 'm1', effort: 'high', account: 'work', worktree: undefined });
  assert.equal(launchBody({ ...d, mode: 'edits' }, 'go').mode, 'edits', 'not Full auto when your default isn’t');
  assert.equal(launchBody(d, 'go').scratch, true, 'no project: a scratch task');
  assert.equal(launchBody({ ...d, worktree: 'off' }, 'go', { path: '/w' }).worktree, false, 'as New task with worktrees off');
  assert.equal(launchBody({ ...d, worktree: 'on' }, 'go', { path: '/w' }).worktree, undefined);
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

test('effectiveGrant: a write scope holds for the code it was allowed on; reads aren’t tied to it', () => {
  const all = ['tasks:read', 'tasks:write'];
  assert.deepEqual(effectiveGrant(all, 'h1', 'h1'), { allowed: all, changed: false });
  assert.deepEqual(effectiveGrant(all, 'h1', 'h2'), { allowed: ['tasks:read'], changed: true });
  assert.deepEqual(effectiveGrant(all, undefined, 'h2'), { allowed: ['tasks:read'], changed: true }, 'no hash: not trusted');
  assert.deepEqual(effectiveGrant(all, '', ''), { allowed: ['tasks:read'], changed: true }, 'an unreadable folder doesn’t match no hash');
  assert.deepEqual(effectiveGrant(['tasks:read'], undefined, ''), { allowed: ['tasks:read'], changed: false });
  assert.deepEqual(effectiveGrant(undefined), { allowed: [], changed: false });
  assert.deepEqual(PANE_WRITES, ['tasks.launch', 'tasks.followUp', 'tasks.done']);
});

test('runsFullAuto: only a running task in Full auto, as the page or the server knows it', () => {
  assert.equal(runsFullAuto({ mode: 'auto', state: 'running' }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', status: 'running' }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', turns: [{ status: 'running' }] }), true);
  assert.equal(runsFullAuto({ mode: 'auto', state: 'review', status: 'done', turns: [{ status: 'done' }] }), false);
  assert.equal(runsFullAuto({ mode: 'edits', state: 'running' }), false);
  assert.equal(runsFullAuto(undefined), false);
  assert.equal(notWhile({ title: 'Big run' }), 'Not while Big run runs in Full auto.');
});

test('paneFrameCsp: exact http(s) origins only, never a wildcard', () => {
  const csp = paneFrameCsp(['http://localhost:47177', 'https://p1--ada.grid.example', 'https://grid.example', 'https://grid.example']);
  assert.equal(csp, "default-src 'none'; style-src 'unsafe-inline'; frame-src http://localhost:47177 https://p1--ada.grid.example https://grid.example");
  for (const bad of ['*', 'https:', 'https://*.grid.example', 'http://*', 'data:', 'blob:', 'javascript:alert(1)', "'self'", "'unsafe-inline'", 'https://a.example/path', 'https://a.example;script-src *', 'https://a.example https://b.example', 'ftp://a.example', '', null, 3]) {
    assert.equal(paneFrameCsp([bad]), "default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'", String(bad));
  }
  assert.match(paneFrameCsp(['http://[::1]:47100']), /frame-src http:\/\/\[::1\]:47100$/);
  const doc = paneWrapperDoc(csp);
  assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script/.test(doc), 'the wrapper runs nothing');
  assert.ok(doc.indexOf('<meta') < doc.indexOf('</head>'), 'a CSP meta only counts in the head');
});

test('showInvisible: what doesn’t print shows as <U+…>; newlines, tabs and the rest stay', () => {
  assert.equal(showInvisible('a\u202Eb'), 'a<U+202E>b');
  for (const c of ['\u200B', '\u200F', '\u202A', '\u202E', '\u2060', '\u2069', '\uFEFF', '\u0000', '\u0007', '\u001B', '\r', '\u007F', '\u0085']) {
    assert.equal(showInvisible(c), `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  }
  assert.equal(showInvisible('\u{E0041}'), '<U+E0041>', 'tag characters spell text only an agent reads');
  assert.equal(showInvisible('line one\n\tline two'), 'line one\n\tline two');
  assert.equal(showInvisible('héllo 日本語 😀 “quoted”'), 'héllo 日本語 😀 “quoted”');
  assert.equal(showInvisible(undefined), '');
});

test('scrubSecrets: tokens are gone from what a frame gets, ordinary words aren’t', () => {
  const secrets = {
    'sk-ant-abcdefghij0123456789klmnop': /sk-ant/,
    'sk-abcdefghijklmnop': /sk-abc/,
    ['ghp_' + 'a'.repeat(36)]: /ghp_/,
    ['gho_' + 'b'.repeat(36)]: /gho_/,
    ['github_pat_' + 'c'.repeat(50)]: /github_pat/,
    AKIAABCDEFGHIJKLMNOP: /AKIA/,
    'xoxb-1234567890-abcdefghij': /xoxb/,
    'Bearer abc.def-ghi1234': /abc\.def/,
    'API_KEY=hunter2': /hunter2/,
    'MY_TOKEN = shortone': /shortone/,
    'DB_PASSWORD=pw': /=pw/,
    'client_secret=s3cr3t': /s3cr3t/,
  };
  for (const [text, gone] of Object.entries(secrets)) {
    const out = scrubSecrets(`Fix it with ${text} please`);
    assert.doesNotMatch(out, gone, text);
    assert.match(out, /^Fix it with .*redacted.* please$/, text);
  }
  for (const fine of ['Rotate the API key next week', 'Fix the token refresh', 'monkey patch sk-learn', 'if (token == null) return', 'Add a password field']) assert.equal(scrubSecrets(fine), fine);
  assert.equal(scrubSecrets(''), '');
  const t = lightTask({ id: 't', title: 'Use API_KEY=abc', preview: `token is ghp_${'d'.repeat(36)}`, live: 'Bearer zzzzzzzzzzzz' });
  assert.ok(![t.title, t.summary, t.live].join(' ').match(/abc|ghp_|zzzz/), 'title, summary and live');
  assert.deepEqual(lightPrs([{ id: 't', title: 'API_KEY=abc', pr: { url: 'u' } }]).map((p) => p.title.includes('abc')), [false]);
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

test('/_wisp/pane.js: answers come from wisp’s page, the parent of the wrapper frame; nobody else’s count', async () => {
  const top = { postMessage() {} };
  const wrapper = { postMessage() {}, parent: top };
  let listen;
  const ctx = { addEventListener: (_, fn) => (listen = fn), console, Promise, Error, Object, Map };
  ctx.window = ctx;
  ctx.parent = wrapper;
  vm.runInNewContext(PANE_CLIENT, ctx);
  let got = 'nothing';
  ctx.wisp.tasks.list().then((x) => (got = x));
  listen({ source: {}, data: { wispPane: 1, id: 1, result: 'forged' } });
  await new Promise(setImmediate);
  assert.equal(got, 'nothing', 'another window can’t answer');
  listen({ source: top, data: { wispPane: 1, id: 1, result: 'real' } });
  await new Promise(setImmediate);
  assert.equal(got, 'real');
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
  let grant = (id) => ({ allowed: S.stuff.find((x) => x.id === id)?.allowed || [], changed: false }); // what GET /stuff/:id/grant answers
  let S;
  set('fetch', async (url, o) => {
    calls.push([String(url), o?.method || 'GET', o?.body]);
    const asked = /\/stuff\/(\w+)\/grant$/.exec(String(url));
    const body = asked ? grant(asked[1]) : { id: 'n1', title: 'New' };
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) };
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
    ({ S } = await import('../web/js/core/state.js'));
    const { paneCall } = await import('../web/js/features/panes.js');
    S.config = { defaults: { agent: 'codex', mode: 'edits' }, projects: [{ id: 'p1', name: 'wisp', path: '/w' }], crew: [{ id: 'm1', name: 'Ada', role: 'Lead', running: true, memory: 'secret' }] };
    S.agents = [{ id: 'codex', name: 'Codex', available: true, models: [] }];
    S.stuff = [{ id: 'a1', kind: 'app', title: 'Board', uses: ['tasks:read', 'tasks:write'], allowed: ['tasks:read'] }];
    S.sessions = new Map([['t1', { id: 't1', title: 'Fix', state: 'review', cwd: '/w', project: 'wisp', agent: 'claude', mode: 'auto' }]]);
    let f = { id: 'a1', where: 'home', writes: [] };
    const cards = [];
    const send = async (spec) => (cards.push(spec), true);
    const pinned = () => true;
    const opts = { card: send, pinned };
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }], opts), /Not allowed: tasks\.launch\(\) needs "tasks:write"/);
    await assert.rejects(paneCall(f, 'crew.list', []), /needs "crew:read"/);
    assert.deepEqual(calls, [], 'nothing reached the API');
    assert.deepEqual(cards, [], 'and no card opened');
    const list = await paneCall(f, 'tasks.list', []);
    assert.deepEqual(list.map((t) => [t.id, t.title, t.cwd]), [['t1', 'Fix', undefined]]);
    await assert.rejects(paneCall(f, 'tasks.get', ['nope']), /No task nope/);

    // Allowed now: a launch still waits on the card, then goes to POST /sessions on your defaults.
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    const out = await paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'wisp' }], opts);
    assert.equal(out.id, 'n1');
    const sent = calls.at(-1);
    assert.deepEqual(sent.slice(0, 2), ['/api/sessions', 'POST']);
    const body = JSON.parse(sent[2]);
    assert.deepEqual([body.prompt, body.cwd, body.agent, body.mode], ['go', '/w', 'codex', 'edits'], 'your mode, not the server’s Full auto');
    assert.equal(cards.at(-1).head, 'Board wants to start a task');
    assert.equal(cards.at(-1).prompt, 'go');
    assert.deepEqual(cards.at(-1).rows, [['Project', 'wisp'], ['Harness', 'Codex'], ['Mode', 'Edits', false]]);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'go', project: 'nowhere' }], opts), /No project nowhere/);
    S.config.defaults.mode = '';
    await paneCall(f, 'tasks.launch', [{ prompt: 'no project' }], opts);
    assert.deepEqual(cards.at(-1).rows, [['Project', 'No project'], ['Harness', 'Codex'], ['Mode', 'Full auto: no permission prompts', true]], 'Full auto says so');
    assert.equal(JSON.parse(calls.at(-1)[2]).scratch, true);
    S.config.defaults.mode = 'edits';
    for (let i = 0; i < 3; i++) await paneCall(f, 'tasks.launch', [{ prompt: `go ${i}` }], opts);
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'one more' }], opts), /Slow down/);

    // Cancel: nothing goes, and it still counted.
    f = { id: 'a1', key: 'x', where: 'home', writes: [] };
    const posts = () => calls.filter((c) => c[1] === 'POST').length;
    let was = posts();
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'no' }], { pinned, card: async () => false }), /^Error: You didn’t send it\.$/);
    assert.equal(posts(), was);
    assert.equal(f.writes.length, 1);

    // One card at a time, from any pane.
    let answer;
    const first = paneCall(f, 'tasks.launch', [{ prompt: 'one' }], { pinned, card: () => new Promise((ok) => (answer = ok)) });
    while (!answer) await new Promise(setImmediate);
    const other = { id: 'a1', where: 'task', writes: [] };
    let opened = false;
    const second = { pinned, card: async () => ((opened = true), true) };
    await assert.rejects(paneCall(other, 'tasks.launch', [{ prompt: 'two' }], second), /^Error: A card is already waiting for you\.$/);
    await assert.rejects(paneCall(other, 'tasks.followUp', ['t1', 'three'], second), /A card is already waiting/);
    assert.equal(opened, false);
    answer(false);
    await assert.rejects(first, /You didn’t send it/);

    // A follow-up's card names the task; it waits on the card too, and tasks.done doesn't.
    f.writes = [];
    let followed;
    const replies = [];
    await paneCall(f, 'tasks.followUp', ['t1', 'and also'], { pinned, sendTo: async (...a) => replies.push(a), card: async (spec) => ((followed = spec), true) });
    assert.equal(followed.head, 'Board wants to send a follow-up');
    assert.deepEqual(followed.rows, [['Task', 'Fix'], ['Harness', 'claude'], ['Mode', 'Full auto: no permission prompts', true], ['State', 'Review']]);
    assert.equal(followed.prompt, 'and also');
    assert.deepEqual(replies, [['t1', 'and also']]);
    await assert.rejects(paneCall(f, 'tasks.followUp', ['gone', 'x'], { pinned, card: async () => assert.fail('no card for a task that isn’t there') }), /No task gone/);

    // After Send, what's true now counts: the pane unpinned, the grant gone, the task gone.
    f.writes = [];
    was = posts();
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'x' }], { card: send, pinned: () => false }), /isn’t pinned any more/);
    await assert.rejects(
      paneCall(f, 'tasks.launch', [{ prompt: 'x' }], {
        pinned,
        card: async () => {
          grant = () => ({ allowed: ['tasks:read'], changed: false });
          return true;
        },
      }),
      /Not allowed: tasks\.launch/,
    );
    grant = () => ({ allowed: ['tasks:read', 'tasks:write'], changed: false });
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    await assert.rejects(
      paneCall(f, 'tasks.followUp', ['t1', 'x'], {
        pinned,
        card: async () => {
          S.sessions.delete('t1');
          return true;
        },
      }),
      /No task t1/,
    );
    S.sessions.set('t1', { id: 't1', title: 'Fix', state: 'review', agent: 'claude', mode: 'auto' });
    assert.equal(posts(), was, 'none of those sent anything');

    // Its code changed: refused in those words, whatever S.stuff still believed, with no card, and
    // S.stuff catches up so the bar can say so.
    f.writes = [];
    S.stuff[0].allowed = ['tasks:read', 'tasks:write'];
    grant = () => ({ allowed: ['tasks:read'], changed: true });
    const noCard = { pinned, card: async () => assert.fail('no card opens by itself') };
    const CHANGED = /^Error: This pane changed since you allowed it: allow it again from its bar\.$/;
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'x' }], noCard), CHANGED);
    assert.deepEqual([S.stuff[0].allowed, S.stuff[0].changed], [['tasks:read'], true]);
    await assert.rejects(paneCall(f, 'tasks.followUp', ['t1', 'x'], noCard), CHANGED, 'and again, now S.stuff knows');
    await assert.rejects(paneCall(f, 'tasks.done', ['t1'], noCard), CHANGED);
    assert.equal((await paneCall(f, 'tasks.list', [])).length, 1, 'reads still work');

    // Going back to that code: the write works again, and the flag goes.
    f.writes = [];
    grant = () => ({ allowed: ['tasks:read', 'tasks:write'], changed: false });
    await paneCall(f, 'tasks.launch', [{ prompt: 'x' }], opts);
    assert.equal(S.stuff[0].changed, undefined);

    // At most six a minute, cancelled ones too.
    f.writes = [];
    for (let i = 0; i < 6; i++) await paneCall(f, 'tasks.launch', [{ prompt: 'no' }], { pinned, card: async () => false }).catch(() => {});
    await assert.rejects(paneCall(f, 'tasks.launch', [{ prompt: 'no' }], noCard), /Slow down/);
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
const appDir = (name, manifest, html = '<!doctype html><title>Board</title><script src="/_wisp/pane.js"></script>') => {
  const dir = path.join(tmp('pane-app'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
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
  assert.equal(page.headers.get('content-security-policy'), PANE_CSP, 'an app that uses wisp');
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
  assert.equal((await fetch(again.url)).headers.get('content-security-policy'), PANE_APP_CSP, 'an app that doesn’t use wisp keeps its network and can’t frame wisp');
  assert.doesNotMatch(PANE_APP_CSP, /connect-src|default-src|http:/);
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
});

test('appHash: any file, any path or the uses change it; order doesn’t; a view stays a few stats', () => {
  const dir = appDir('hash', { name: 'H' });
  const was = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.match(was, /^[0-9a-f]{64}$/);
  assert.equal(appHash(dir, ['tasks:write', 'tasks:read']), was, 'uses are sorted');
  assert.notEqual(appHash(dir, ['tasks:read']), was);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...a) => (reads++, read(...a));
  try {
    assert.equal(appHash(dir, ['tasks:read', 'tasks:write']), was);
    assert.equal(reads, 0, 'nothing moved: nothing read');
  } finally {
    fs.readFileSync = read;
  }
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'one');
  const one = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.notEqual(one, was);
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'two');
  assert.notEqual(appHash(dir, ['tasks:read', 'tasks:write']), one, 'same size, new content');
  fs.renameSync(path.join(dir, 'js', 'a.js'), path.join(dir, 'js', 'b.js'));
  const moved = appHash(dir, ['tasks:read', 'tasks:write']);
  assert.notEqual(moved, one);
  // The same size and time put back after an edit: ctime still shows it.
  const file = path.join(dir, 'js', 'b.js');
  const st = fs.statSync(file);
  fs.writeFileSync(file, 'xxx');
  fs.utimesSync(file, st.atime, st.mtime);
  assert.notEqual(appHash(dir, ['tasks:read', 'tasks:write']), moved);
  assert.throws(() => appHash(path.join(dir, 'nope'), []));
});

test('a write grant dies with the code it was given on, and comes back with it; reads aren’t tied', async () => {
  const it = srv.stuff.addApp(appDir('tied', { name: 'Tied', uses: ['tasks:read', 'tasks:write', 'prs:read'] }));
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: [], changed: false });
  const view = await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] });
  assert.deepEqual(view.allowed, ['tasks:read', 'tasks:write']);
  assert.equal(view.changed, undefined);
  assert.ok(!('grantHash' in view), 'the hash stays on the server');
  const stored = srv.stuff.get(it.id).grantHash;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false });

  // An edit in its folder (an agent, a person): the write's off, read isn't, nothing's deleted.
  const page = path.join(srv.stuff.get(it.id).path, 'index.html');
  const code = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${code}<!-- changed -->`);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: true });
  const seen = (await api('/stuff')).items.find((x) => x.id === it.id);
  assert.deepEqual([seen.allowed, seen.changed, 'grantHash' in seen], [['tasks:read'], true, false]);
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:read', 'tasks:write'], 'stored as it was');
  fs.writeFileSync(page, code);
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false }, 'the same code: back');

  // wisp_save with an update: the same, and Back to the version before restores it.
  srv.stuff.addApp(appDir('tied2', { name: 'Tied', uses: ['tasks:read', 'tasks:write', 'prs:read'] }, '<!doctype html><title>New</title>'), { replace: it.id });
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: true });
  await api(`/stuff/${it.id}/restore`, {});
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read', 'tasks:write'], changed: false });

  // Allowing it again ties it to the code as it is; narrowing to reads drops the hash.
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '1');
  assert.equal((await api(`/stuff/${it.id}/grant`)).changed, true);
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] });
  assert.notEqual(srv.stuff.get(it.id).grantHash, stored);
  assert.equal((await api(`/stuff/${it.id}/grant`)).changed, false);
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] });
  assert.equal(srv.stuff.get(it.id).grantHash, undefined);
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '2');
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: ['tasks:read'], changed: false }, 'reads aren’t tied to the code');

  // A grant from before this rule, with no hash: no write.
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:write'] });
  delete srv.stuff.get(it.id).grantHash;
  assert.deepEqual(await api(`/stuff/${it.id}/grant`), { allowed: [], changed: true });
  await assert.rejects(api('/stuff/nope/grant'), (e) => e.status === 404);
});

test('POST /stuff/:id/allow: no new scope while its own task runs in Full auto; narrowing always works', async () => {
  const running = (id, mode = 'auto', extra = {}) => srv.store.put({ id, title: 'Big run', state: 'running', mode, turns: [{ id: 'u1', status: 'running' }], ...extra });
  running('fa-task');
  running('fa-other', 'auto', { title: 'Crew job' });
  running('edits-task', 'edits');
  srv.store.put({ id: 'fa-idle', title: 'Done run', state: 'review', mode: 'auto', turns: [{ id: 'u1', status: 'done' }] });
  const it = srv.stuff.addApp(appDir('auto', { name: 'Auto', uses: ['tasks:read', 'tasks:write'] }), { from: { session: 'fa-task', title: 'Big run' } });
  const refused = (e) => e.status === 409 && e.message.endsWith('Not while Big run runs in Full auto.');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] }), refused, 'the task that made it');
  srv.stuff.get(it.id).from = { session: 'fa-idle', title: 'x' };
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'] })).allowed, ['tasks:read'], 'it isn’t running now');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' }), refused, 'the task it’s shown on');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'edits-task' })).allowed, ['tasks:read', 'tasks:write'], 'another mode');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' })).allowed, ['tasks:read', 'tasks:write'], 'adds nothing');
  assert.deepEqual((await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read'], task: 'fa-task' })).allowed, ['tasks:read'], 'narrowing works');
  await api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'] }); // fa-other runs in Full auto: none of its business
  assert.deepEqual(srv.stuff.get(it.id).allowed, ['tasks:read', 'tasks:write'], 'an unrelated Full auto task doesn’t block');
  // Its code moved: allowing tasks:write again is adding, by the effective grant.
  fs.writeFileSync(path.join(srv.stuff.get(it.id).path, 'extra.js'), '1');
  await assert.rejects(api(`/stuff/${it.id}/allow`, { uses: ['tasks:read', 'tasks:write'], task: 'fa-task' }), refused);
  assert.equal((await api(`/stuff/${it.id}/allow`, undefined, 'DELETE')).allowed, undefined, 'DELETE always works');
  for (const id of ['fa-task', 'fa-other', 'edits-task', 'fa-idle']) srv.store.remove?.(id);
});

test('scanApp: literal WebRTC in its html and js; view says so only for an app that uses wisp', () => {
  assert.deepEqual(scanApp(appDir('clean', {})), []);
  for (const [i, code] of ['new RTCPeerConnection()', 'x = RTCDataChannel', 'webkitRTCPeerConnection'].entries()) {
    const html = appDir(`rtc-html-${i}`, {}, `<script>${code}</script>`);
    assert.deepEqual(scanApp(html), ['webrtc'], code);
  }
  const deep = appDir('rtc-js', {});
  fs.mkdirSync(path.join(deep, 'lib'));
  fs.writeFileSync(path.join(deep, 'lib', 'peer.mjs'), 'new RTCPeerConnection()');
  assert.deepEqual(scanApp(deep), ['webrtc']);
  const other = appDir('rtc-md', {});
  fs.writeFileSync(path.join(other, 'notes.md'), 'RTCPeerConnection');
  assert.deepEqual(scanApp(other), [], 'only code');
  const uses = srv.stuff.addApp(appDir('rtc-use', { name: 'Rtc', uses: ['tasks:read'] }, '<script>new RTCPeerConnection()</script>'));
  assert.deepEqual(srv.stuff.view(uses).risky, ['webrtc']);
  const none = srv.stuff.addApp(appDir('rtc-none', { name: 'Rtc2' }, '<script>new RTCPeerConnection()</script>'));
  assert.equal(srv.stuff.view(none).risky, undefined);
});

test('an app can’t write to wisp', async () => {
  const it = srv.stuff.addApp(appDir('quiet', { name: 'Quiet' }));
  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/sessions`, { method: 'POST', headers: { origin: 'http://localhost:47177', 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{"prompt":"x"}');
  });
  assert.equal(status, 403);
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
  assert.ok(url);
});

test('a grant never leaves: not with a published app, not with a shared task', async () => {
  const it = srv.stuff.addApp(appDir('leave', { name: 'Leave', uses: ['tasks:read', 'tasks:write'] }));
  srv.stuff.allow(it.id, ['tasks:read', 'tasks:write']);
  const { allowed, grantHash } = srv.stuff.get(it.id);
  assert.ok(allowed.length && grantHash);

  const got = [];
  const grid = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      got.push({ url: req.url, body: Buffer.concat(parts).toString('latin1') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://x.example/s', rev: 1 }));
    });
  });
  await new Promise((r) => grid.listen(0, '127.0.0.1', r));
  try {
    const publish = createPublish({ stuff: srv.stuff }, { env: { WISP_GRID_URL: `http://127.0.0.1:${grid.address().port}`, WISP_TRUSTED_PROXY_SECRET: 's', WISP_PUBLIC_URL: 'https://ada.grid.example' } });
    await publish.publish(it.id, {});
  } finally {
    grid.closeAllConnections?.();
    grid.close();
  }
  assert.equal(got.length, 1);
  assert.match(got[0].body, /index\.html/, 'its files went');
  const out = JSON.stringify(got);
  assert.ok(!out.includes(grantHash) && !out.includes('"allowed"') && !out.includes('grantHash'));
  assert.equal(path.dirname(srv.stuff.get(it.id).path), srv.stuff.dir, 'the grant is in the record, beside the folder');
  assert.ok(!fs.readdirSync(srv.stuff.get(it.id).path).some((f) => fs.readFileSync(path.join(srv.stuff.get(it.id).path, f), 'utf8').includes(grantHash)));

  const dir = tmp('pane-share');
  const turns = [{ presentation: { blocks: [{ type: 'stuff', id: it.id }] } }];
  packAttached([turns], { dir, cwd: dir, stuff: srv.stuff });
  const card = JSON.stringify(turns);
  assert.match(card, /"Leave"/);
  assert.ok(!card.includes('allowed') && !card.includes('grantHash'));
});

test('PATCH /config checks the panes setting', async () => {
  await assert.rejects(api('/config', { defaults: { panes: 'board@nowhere' } }, 'PATCH'), /@task or @home/);
  const out = await api('/config', { defaults: { panes: 'board@home' } }, 'PATCH');
  assert.equal(out.defaults.panes, 'board@home');
  await api('/config', { defaults: { panes: '' } }, 'PATCH');
});
