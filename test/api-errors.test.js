// What a person reads when a request gets no answer: the browser's own words never reach a toast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The page's listeners: Node has no window.
const page = {};
globalThis.addEventListener = (type, fn) => (page[type] = fn);
const { api, upload, reach } = await import('../web/js/core/api.js');
delete globalThis.addEventListener;
const real = globalThis.fetch;
const answer = (fn) => (globalThis.fetch = fn);
test.afterEach(() => (globalThis.fetch = real));

const CANT_REACH = 'Can’t reach wisp. Check the connection and try again.';

for (const [browser, text] of [['Chrome', 'Failed to fetch'], ['Firefox', 'NetworkError when attempting to fetch resource.'], ['Safari', 'Load failed']]) {
  test(`${browser}'s words for no connection become wisp's`, async () => {
    answer(() => Promise.reject(new TypeError(text)));
    await assert.rejects(api('/sessions'), { message: CANT_REACH });
    await assert.rejects(upload(new Blob(['x']), { name: 'a', type: 'text/plain' }), { message: CANT_REACH });
  });
}

test('a request given up on says so, and to try again', async () => {
  answer(() => Promise.reject(new DOMException('signal timed out', 'TimeoutError')));
  await assert.rejects(api('/sessions/x', { timeout: 5 }), { message: 'wisp took too long to answer. Try again.' });
});

test('anything else thrown on the way is left as it is', async () => {
  const bug = new RangeError('a bug in the page');
  answer(() => Promise.reject(bug));
  await assert.rejects(api('/sessions'), (err) => err === bug);
});

for (const status of [502, 503, 504]) {
  test(`a proxy's ${status} page with no message of ours reads as no connection, with its status`, async () => {
    answer(async () => new Response('<html>Bad Gateway</html>', { status, statusText: 'Bad Gateway' }));
    await assert.rejects(api('/sessions'), { message: CANT_REACH, status });
    await assert.rejects(upload(new Blob(['x']), { name: 'a', type: 'text/plain' }), { message: CANT_REACH, status });
  });
}

test("the server's own message always wins", async () => {
  answer(async () => new Response(JSON.stringify({ error: 'Still working — stop it first.' }), { status: 503 }));
  await assert.rejects(api('/sessions'), { message: 'Still working — stop it first.', status: 503 });
  await assert.rejects(upload(new Blob(['x']), { name: 'a', type: 'text/plain' }), { message: 'Still working — stop it first.' });
});

test('a refusal with no message and no status text (HTTP/2) is never an empty toast', async () => {
  answer(async () => new Response('', { status: 500, statusText: '' }));
  await assert.rejects(api('/sessions'), (err) => err.message.length > 0 && err.status === 500);
});

test('reach() is fetch with the same words, for what can’t go through api()', async () => {
  answer(() => Promise.reject(new TypeError('Failed to fetch')));
  await assert.rejects(reach('/_grid/keys'), { message: CANT_REACH });
  answer(async () => new Response('ok'));
  assert.equal(await (await reach('/x')).text(), 'ok');
});

test('no call in web/js that can reach a person goes round reach()', () => {
  for (const file of ['features/stuff.js', 'features/api-keys.js']) {
    const src = fs.readFileSync(new URL(`../web/js/${file}`, import.meta.url), 'utf8');
    const raw = src.match(/[^.\w]fetch\(.*/g) || [];
    // A picture from another site has its own fallback: its link.
    assert.deepEqual(raw.filter((l) => !l.includes('fetch(src)')), [], file);
  }
});

test('a request cut off by a reload fails quietly, and only while the page is leaving', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  answer(() => Promise.reject(new TypeError('Load failed'))); // WebKit fails it before pagehide
  page.beforeunload();
  const outcome = await Promise.race([api('/tools').then(() => 'answered', () => 'failed'), new Promise((r) => setTimeout(r, 20, 'waiting'))]);
  assert.equal(outcome, 'waiting');
  t.mock.timers.tick(2001); // a vscode:// link fires beforeunload too, and that page stays
  await assert.rejects(api('/tools'), { message: CANT_REACH });
});
