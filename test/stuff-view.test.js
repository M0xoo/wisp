// The page's code (web/js/features/stuff.js, feed.js, ui/overlay.js) loaded in node over a stub
// DOM: what opening something (My Stuff, a task) does to a dialog or viewer already on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Anything the page's modules touch at load answers with something that takes any call.
const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });
// The one modal layer, showing the image viewer: overlay.js's close() hides it.
const overlay = {
  hidden: false,
  closed: 0,
  close() {
    this.closed++;
    this.hidden = true;
  },
};
globalThis.document = new Proxy({}, { get: (t, k) => (k === 'querySelector' ? (s) => (s === '#overlay' ? overlay : any()) : k === 'querySelectorAll' ? () => [] : any()) });
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.history = { pushState() {}, replaceState() {}, state: null };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '' });
globalThis.visualViewport = undefined;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
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
const realInterval = globalThis.setInterval;
globalThis.setInterval = () => 0; // the page's pollers would keep the test running
const { openStuff } = await import('../web/js/features/stuff.js');
const { reveal } = await import('../web/js/features/feed.js');
const { overlay: showOverlay } = await import('../web/js/ui/overlay.js');
globalThis.setInterval = realInterval;

test('openStuff: Open on the Saved to My Stuff toast closes the image viewer it was saved from', () => {
  overlay.hidden = false;
  overlay.closed = 0;
  openStuff();
  assert.equal(overlay.closed, 1, 'the viewer (#overlay) is closed');
  assert.equal(overlay.hidden, true);
});

test('openStuff: with nothing over the page, nothing is closed', () => {
  overlay.hidden = true;
  overlay.closed = 0;
  openStuff();
  assert.equal(overlay.closed, 0);
});

// reveal() is what every Open on a toast or notification runs (a reminder, a finished task, a side
// discussion, Sent to…): the task comes into view, so nothing may stay over it.
test('reveal: Open on a reminder or finished-task toast closes the viewer or dialog over the page', () => {
  overlay.hidden = false;
  overlay.closed = 0;
  try {
    reveal('nope'); // a task the list doesn't have (a subagent's run): it still opens
  } catch {} // the stub DOM can't lay out a card; what matters is the overlay
  assert.equal(overlay.closed, 1, 'the viewer (#overlay) is closed');
  assert.equal(overlay.hidden, true);
});

test('reveal: with nothing over the page, nothing is closed', () => {
  overlay.hidden = true;
  overlay.closed = 0;
  try {
    reveal('nope');
  } catch {}
  assert.equal(overlay.closed, 0);
});

// The palette (and Settings, Memory, Compare…) close themselves, then reveal() closes the overlay
// again while it fades: a dialog's onClose (a spell review's answer, the palette's state) runs once.
test('overlay: closing a dialog twice runs its onClose once', () => {
  const o = { hidden: true, innerHTML: '', firstChild: null, classList: { add() {}, remove() {} }, append(n) { this.firstChild = n; } };
  const node = { querySelectorAll: () => [] };
  const real = document.querySelector;
  globalThis.document = new Proxy({}, { get: (t, k) => (k === 'querySelector' ? (s) => (s === '#overlay' ? o : any()) : k === 'querySelectorAll' ? () => [] : any()) });
  try {
    let n = 0;
    const close = showOverlay(node, { onClose: () => n++ });
    close();
    o.close();
    assert.equal(n, 1);
  } finally {
    globalThis.document = new Proxy({}, { get: (t, k) => (k === 'querySelector' ? real : k === 'querySelectorAll' ? () => [] : any()) });
  }
});
