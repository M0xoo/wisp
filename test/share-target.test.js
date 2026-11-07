// Sharing to wisp from a phone's share sheet: the manifest's share_target, what the service worker
// does with the POST, the caps, and what the server says when no worker took it. The page's side
// runs in real Chrome (WEB-65 in qa/web.mjs), the Android app's in its own scenario (MOB-33).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installFakeBins, isolateAgentConfigs, makeRepo, tmp } from './helpers.js';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const ANDROID = fileURLToPath(new URL('../mobile/android/app/src/main/', import.meta.url));
await import('../web/js/share-form.js');
const { MAX_BYTES, MAX_FILES, fits, keep, leftOut, promptOf, take } = globalThis.wispShareForm;

const MB = 1024 * 1024;
const file = (name, size, type = 'image/png') => new File([new Uint8Array(size)], name, { type });

// Enough of the Cache API, with its own copies: what's read back is what was stored.
function fakeCaches() {
  const open = new Map();
  const of = (name) => {
    if (!open.has(name)) {
      const m = new Map();
      open.set(name, {
        m,
        put: async (k, r) => void m.set(String(k), await r.clone()),
        match: async (k) => m.get(String(k))?.clone(),
        delete: async (k) => m.delete(String(k.url || k)),
        keys: async () => [...m.keys()].map((url) => ({ url })),
      });
    }
    return open.get(name);
  };
  return { open: async (name) => of(name), peek: of };
}
const post = (form) => new Request('http://wisp.test/share', { method: 'POST', body: form });
const formOf = (fields, files = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const x of files) f.append('files', x, x.name);
  return f;
};

test('the manifest offers wisp in the share sheet, by POST, with the fields the worker reads', () => {
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.deepEqual(m.share_target, {
    action: '/share',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: globalThis.wispShareForm.FILE_TYPES }] },
  });
  assert.deepEqual(globalThis.wispShareForm.FILE_TYPES, ['image/*', 'text/*', 'application/pdf']);
});

test('caps: 10 files, 20 MB, in order, and a small file after a huge one still goes', () => {
  assert.equal(MAX_FILES, 10);
  assert.equal(MAX_BYTES, 20 * MB);
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `${i}`, size: 1 }));
  assert.deepEqual([fits(many).kept.length, fits(many).left], [10, 2]);
  const r = fits([{ name: 'a', size: 15 * MB }, { name: 'huge', size: 6 * MB }, { name: 'b', size: 5 * MB }, { name: 'c', size: 1 }]);
  assert.deepEqual(r.kept.map((f) => f.name), ['a', 'b']);
  assert.equal(r.left, 2);
  assert.equal(fits([{ name: 'exact', size: 20 * MB }]).left, 0);
  assert.equal(leftOut(1), 'Left out 1 file: a share takes 10 files and 20 MB at most.');
  assert.equal(leftOut(2), 'Left out 2 files: a share takes 10 files and 20 MB at most.');
});

test('what goes in the box: title, text, address, without the repeats apps send', () => {
  assert.equal(promptOf({ title: 'A page', text: 'Look at this', url: 'https://a.test/x' }), 'A page\n\nLook at this\n\nhttps://a.test/x');
  assert.equal(promptOf({ title: 'A page', text: 'A page https://a.test/x', url: 'https://a.test/x' }), 'A page https://a.test/x');
  assert.equal(promptOf({ url: ' https://a.test/x ' }), 'https://a.test/x');
  assert.equal(promptOf({}), '');
});

test('a text-only share is kept, read once and gone', async () => {
  const store = fakeCaches();
  // A share with no files still sends the field, as an empty file.
  const id = await keep(post(formOf({ title: 'Hello', text: 'A note', url: 'https://a.test/' }, [new File([], '')])), store);
  const got = await take(id, store);
  assert.deepEqual({ ...got }, { title: 'Hello', text: 'A note', url: 'https://a.test/', files: [], left: 0 });
  assert.equal(await take(id, store), null, 'read once');
  assert.equal(store.peek('wisp-shared').m.size, 0, 'nothing stays');
});

test('a files-only share comes back as files, bytes and all, over the caps left out', async () => {
  const store = fakeCaches();
  const big = new File([new Uint8Array(19 * MB)], 'big.png', { type: 'image/png' });
  const note = new File(['hello'], 'note.txt', { type: 'text/plain' });
  const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
  const id = await keep(post(formOf({}, [big, file('over.png', 2 * MB), note, pdf])), store);
  const got = await take(id, store);
  assert.deepEqual(got.files.map((f) => [f.name, f.type.split(';')[0]]), [['big.png', 'image/png'], ['note.txt', 'text/plain'], ['a.pdf', 'application/pdf']]);
  assert.equal(await got.files[1].text(), 'hello');
  assert.equal(got.files[0].size, 19 * MB);
  assert.equal(got.left, 1);
  assert.deepEqual([got.title, got.text, got.url], ['', '', '']);
});

test('ids are random and checked; a share nobody opened goes with the next one', async () => {
  const store = fakeCaches();
  const old = await keep(post(formOf({ text: 'old' })), store, Date.now() - 25 * 3600 * 1000);
  const recent = await keep(post(formOf({ text: 'recent' })), store, Date.now() - 3600 * 1000);
  assert.notEqual(old, recent);
  const now = await keep(post(formOf({ text: 'now' })), store);
  assert.equal(await take(old, store), null);
  assert.equal((await take(recent, store)).text, 'recent');
  assert.equal((await take(now, store)).text, 'now');
  assert.equal(await take('../shell', store), null);
});

// The worker itself: web/sw.js and share-form.js in a context of their own, as a browser loads them.
function worker({ form = true } = {}) {
  const listeners = {};
  const store = fakeCaches();
  const self = { addEventListener: (ev, fn) => (listeners[ev] = fn), skipWaiting() {}, clients: { claim() {} } };
  const ctx = vm.createContext({ self, caches: store, location: { origin: 'http://wisp.test' }, URL, Response, Request, FormData, File, crypto, fetch: () => assert.fail('no network') });
  self.self = self;
  ctx.importScripts = (url) => {
    assert.equal(url, '/js/share-form.js');
    if (!form) throw new Error('offline');
    vm.runInContext(fs.readFileSync(path.join(WEB, 'js/share-form.js'), 'utf8'), ctx);
    self.wispShareForm = vm.runInContext('globalThis.wispShareForm', ctx);
  };
  vm.runInContext(fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8'), ctx);
  const fetchEvent = (request) => {
    let answer = null;
    listeners.fetch({ request, respondWith: (p) => (answer = p) });
    return answer;
  };
  return { fetchEvent, store };
}

test('the worker answers the share with a 303 to /?shared=<id>, and the page can read it', async () => {
  const { fetchEvent, store } = worker();
  const r = await fetchEvent(post(formOf({ text: 'From the worker' }, [new File(['x'], 'a.txt', { type: 'text/plain' })])));
  assert.equal(r.status, 303);
  const u = new URL(r.headers.get('location'));
  assert.equal(`${u.origin}${u.pathname}`, 'http://wisp.test/');
  const got = await take(u.searchParams.get('shared'), store);
  assert.equal(got.text, 'From the worker');
  assert.equal(got.files[0].name, 'a.txt');
});

test('a form that can’t be read still lands on the page, and the page says so', async () => {
  const { fetchEvent, store } = worker();
  const bad = new Request('http://wisp.test/share', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'not a form' });
  const r = await fetchEvent(bad);
  assert.equal(r.status, 303);
  assert.equal(await take(new URL(r.headers.get('location')).searchParams.get('shared'), store), null);
});

test('the worker leaves every other POST to the network, and a share too if it lost share-form.js', () => {
  const { fetchEvent } = worker();
  assert.equal(fetchEvent(new Request('http://wisp.test/api/sessions', { method: 'POST', body: '{}' })), null);
  assert.equal(fetchEvent(new Request('http://wisp.test/shared', { method: 'POST', body: '{}' })), null);
  const lost = worker({ form: false });
  assert.equal(lost.fetchEvent(post(formOf({ text: 'x' }))), null, 'the server answers it instead');
});

// --- what the server says when no worker took it ----------------------------------------------

const SECRET = 'x'.repeat(40);
process.env.WISP_HOME = tmp('share-target-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_TRUSTED_PROXY_SECRET = SECRET;
process.env.WISP_PUBLIC_URL = 'https://ada.grid.test';
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
let port;
before(async () => {
  port = await freePort();
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

// A raw request: fetch would follow the redirect, and won't set Host.
function raw(pathname, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cache: res.headers['cache-control'], text: t }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const MULTI = { 'content-type': 'multipart/form-data; boundary=x' };
const FORM = '--x\r\ncontent-disposition: form-data; name="text"\r\n\r\nhello\r\n--x--\r\n';

test('POST /share with no worker: a 303 to the page that says why, the form left unread', async () => {
  const r = await raw('/share', { headers: MULTI, body: FORM });
  assert.deepEqual([r.status, r.location, r.cache, r.text], [303, '/?shared=none', 'no-store', '']);
});

test('…through the phone’s tunnel (Host 127.0.0.1, Origin the same), with or without an Origin', async () => {
  for (const origin of [`http://127.0.0.1:${port}`, undefined, 'null']) {
    const r = await raw('/share', { headers: { ...MULTI, ...(origin && { origin }) }, body: FORM });
    assert.deepEqual([r.status, r.location], [303, '/?shared=none'], String(origin));
  }
});

test('…behind a trusted proxy (the grid), whatever Origin the browser sent', async () => {
  for (const origin of ['https://ada.grid.test', 'https://elsewhere.test', undefined]) {
    const r = await raw('/share', { headers: { ...MULTI, host: 'ada.grid.test', 'x-wisp-proxy-secret': SECRET, ...(origin && { origin }) }, body: FORM });
    assert.deepEqual([r.status, r.location], [303, '/?shared=none'], String(origin));
  }
});

test('…and over the caps, it still answers: the body is dropped, not kept', async () => {
  const r = await raw('/share', { headers: MULTI, body: Buffer.alloc(25 * MB) });
  assert.equal(r.status, 303);
});

test('it opens nothing else: another host is refused, and other non-JSON posts still are', async () => {
  assert.equal((await raw('/share', { headers: { ...MULTI, host: 'evil.test' }, body: FORM })).status, 403);
  assert.equal((await raw('/shared', { headers: MULTI, body: FORM })).status, 415);
  assert.equal((await raw('/api/sessions', { headers: MULTI, body: FORM })).status, 415);
  const page = await raw('/share', { method: 'GET' });
  assert.equal(page.status, 200, 'GET is the page, like any other path');
});

test('the Shortcut’s request: a prompt alone starts a task, in a scratch folder or one you name', async () => {
  for (const where of [{ scratch: true }, { cwd: makeRepo() }]) {
    const body = JSON.stringify({ prompt: 'From a Shortcut', agent: 'claude', ...where });
    const r = await raw('/api/sessions', { headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 201, r.text);
  }
});

// --- the Android app's manifest ---------------------------------------------------------------

test('Android: wisp takes shares of text, images and PDFs, and keeps its other ways in', () => {
  const xml = fs.readFileSync(path.join(ANDROID, 'AndroidManifest.xml'), 'utf8');
  const filters = [...xml.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)].map((m) => m[1]);
  const send = filters.find((f) => f.includes('action.SEND"'));
  assert.ok(send, 'a SEND filter');
  assert.match(send, /action\.SEND_MULTIPLE"/);
  assert.match(send, /category\.DEFAULT"/);
  assert.deepEqual([...send.matchAll(/mimeType="([^"]+)"/g)].map((m) => m[1]), ['text/*', 'image/*', 'application/pdf']);
  assert.ok(filters.some((f) => f.includes('action.MAIN') && f.includes('category.LAUNCHER')), 'the launcher icon');
  assert.ok(filters.some((f) => f.includes('action.VIEW') && f.includes('android:scheme="dev.trywisp.mobile"')), 'the grid’s link back');
});

test('Android: same caps as the page, and its own files are never shared out', () => {
  const java = fs.readFileSync(path.join(ANDROID, 'java/dev/trywisp/mobile/Shared.java'), 'utf8');
  assert.match(java, new RegExp(`MAX_FILES = ${MAX_FILES};`));
  assert.match(java, new RegExp(`MAX_BYTES = ${MAX_BYTES / MB}L \\* 1024 \\* 1024;`));
  assert.match(java, /"content"\.equals/);
});
