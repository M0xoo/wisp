// The Preview bar in the page (web/js/features/run.js) is rebuilt when its state changes. Loaded in
// node over a stub DOM: the keyboard stays where it was, or on the bar when that control is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { activeElement: null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), documentElement: { dataset: {}, classList: { contains: () => false } }, addEventListener() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '' }; // Node 20

const { paintBar } = await import('../web/js/features/run.js');

// A control the bar can rebuild: focus() is what the page would do with it.
const control = (a, { disabled = false } = {}) => {
  const el = { dataset: { a }, disabled, focus() { document.activeElement = el; } };
  return el;
};
function barOf(before, after) {
  const bar = {
    dataset: {},
    kids: before,
    focus() { document.activeElement = bar; },
    contains: (el) => bar.kids.includes(el) || el === bar,
    querySelector: (sel) => bar.kids.find((k) => sel === `[data-a="${k.dataset.a}"]`) || null,
    set innerHTML(_) {
      bar.kids = after;
      if (before.includes(document.activeElement)) document.activeElement = null; // the node is gone
    },
  };
  return bar;
}

test('Logs pressed: the rebuilt bar keeps the keys on Logs', () => {
  const was = control('run-logs');
  const now = control('run-logs');
  const bar = barOf([control('run-pick'), was], [control('run-pick'), now]);
  document.activeElement = was;
  paintBar(bar, 'x');
  assert.equal(document.activeElement, now);
});

test('the control went disabled (Logs while it restarts): the keys stay on the bar', () => {
  const was = control('run-logs');
  const bar = barOf([was], [control('run-logs', { disabled: true })]);
  document.activeElement = was;
  paintBar(bar, 'x');
  assert.equal(document.activeElement, bar);
});

test('focus somewhere else stays there', () => {
  const reply = control('reply');
  const bar = barOf([control('run-logs')], [control('run-logs')]);
  document.activeElement = reply;
  paintBar(bar, 'x');
  assert.equal(document.activeElement, reply);
});

test('the same bar is not rebuilt', () => {
  const was = control('run-logs');
  const bar = barOf([was], []);
  bar.dataset.h = 'x';
  document.activeElement = was;
  paintBar(bar, 'x');
  assert.equal(document.activeElement, was);
});
