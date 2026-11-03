// My Stuff's page code (web/js/features/stuff.js) loaded in node over a stub DOM: what openStuff()
// does to whatever else is on screen.
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
for (const n of ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'])
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
