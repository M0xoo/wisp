// Ship it's request in the page (web/js/features/ship.js) loaded in node over a stub DOM: however it
// ends the folder moved, so what shows the folder (panel.js: Changes, the place line) hears of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });
globalThis.document = new Proxy({}, { get: (t, k) => (k === 'querySelectorAll' ? () => [] : any()) });
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.history = { pushState() {}, replaceState() {}, state: null };
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '', clipboard: { writeText: async () => {} } }; // Node 20
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.visualViewport = undefined;
globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '' });
for (const n of ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'])
  globalThis[n] ||= class {
    constructor() {
      return any();
    }
    get value() {
      return '';
    }
    set value(v) {}
  };
globalThis.setInterval = () => 0; // the page's pollers would keep the test running
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => {
  const t = realTimeout(...a);
  t.unref?.(); // nor do its toasts' timers
  return t;
};

const reply = (status, body) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });

const { sendShip } = await import('../web/js/features/ship.js');
const bus = await import('../web/js/core/bus.js');
const { S } = await import('../web/js/core/state.js');

const shippedAfter = async (res) => {
  const heard = [];
  const off = bus.on('shipped', (id) => heard.push(id));
  globalThis.fetch = async () => res;
  S.sessions.set('t1', { id: 't1', shipping: { step: 'push' }, toShip: { dirty: 2, unpushed: 0 } });
  await sendShip('t1', { title: 'x', body: '', draft: false }, false);
  off?.();
  return heard;
};

test('a ship that lands says so: Changes and the place line look again', async () => {
  assert.deepEqual(await shippedAfter(reply(200, { number: 7, url: 'https://x/7', state: 'OPEN' })), ['t1']);
  assert.equal(S.sessions.get('t1').toShip.dirty, 0);
});

test('a ship that fails says so too: the commit landed before the push failed', async () => {
  assert.deepEqual(await shippedAfter(reply(500, { error: 'push rejected' })), ['t1']);
  assert.equal(S.sessions.get('t1').shipping, null);
});
