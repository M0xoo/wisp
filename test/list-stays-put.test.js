// The task list moves only for you. The page's code (scroll.js, launcher.js) loaded in node over a
// stub DOM, with a sidebar 700px tall under a 40px pinned head. The list staying put through a real
// run is `node qa/web.mjs` (WEB-63): renderFeed needs a real page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });
const wrap = { scrollTop: 1000, getBoundingClientRect: () => ({ top: 60, bottom: 760 }) };
const splitTop = { offsetHeight: 40 };
const classes = new Set(['split']);
const body = new Proxy({}, { get: (t, k) => (k === 'classList' ? { contains: (c) => classes.has(c), add() {}, remove() {}, toggle() {} } : any()) });
globalThis.document = new Proxy({}, { get: (t, k) => (k === 'body' ? body : k === 'querySelector' ? (s) => (s === '#feedWrap' ? wrap : s === '#splitTop' ? splitTop : any()) : k === 'querySelectorAll' ? () => [] : any()) });
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.history = { pushState() {}, replaceState() {}, state: null };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '' });
globalThis.visualViewport = undefined;
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '' }; // Node 20
globalThis.innerWidth = 1440;
globalThis.innerHeight = 800;
for (const n of ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'])
  globalThis[n] ||= class {
    constructor() {
      return any();
    }
  };
const realInterval = globalThis.setInterval;
globalThis.setInterval = () => 0; // the page's pollers would keep the test running
const { showLaunched } = await import('../web/js/features/launcher.js');
const { rowShows, showRow } = await import('../web/js/features/scroll.js');
globalThis.setInterval = realInterval;

const row = (top, height = 44) => {
  const c = {
    isConnected: true,
    moved: [],
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top, bottom: top + height, height, left: 10 }),
    scrollIntoView: (o) => c.moved.push(o),
  };
  return c;
};
const btn = { getBoundingClientRect: () => ({ left: 700, top: 300, width: 30, height: 30 }) };

test('a launch beside the list never scrolls it: a row out of view gets the toast', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const below = row(2500);
  assert.equal(showLaunched(btn, below), true, 'a toast says it went');
  assert.deepEqual(below.moved, []);
});

test('a launch whose row shows has the wisp, and no toast', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shown = row(300);
  assert.equal(showLaunched(btn, shown), false);
  assert.deepEqual(shown.moved, []);
});

test('a row with nowhere to show (its section folded) still gets the toast', () => {
  assert.equal(showLaunched(btn, undefined), true);
  assert.equal(showLaunched(btn, { ...row(0), isConnected: false }), true);
});

test('showRow moves the list for a row out of view, just enough, clear of the pinned head', () => {
  for (const [top, dy] of [[2500, 1784], [-400, -500], [70, -30], [100, 0], [300, 0], [716, 0], [717, 1]]) {
    const c = row(top);
    assert.equal(rowShows(c), !dy, `row at ${top}`);
    wrap.scrollTop = 1000;
    showRow(c);
    assert.equal(wrap.scrollTop, 1000 + dy, `row at ${top}`);
  }
  showRow(undefined);
});
