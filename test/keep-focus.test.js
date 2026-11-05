// Sending from a finished task moves its row from Needs you to Working, taking the reply box out of
// the page for a moment. Loaded in node over a stub DOM: the keys stay in the box, or the next word
// typed would land on wisp's one-key shortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const body = {};
globalThis.document = { body, activeElement: body, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), documentElement: { dataset: {}, classList: { contains: () => false, add() {}, remove() {}, toggle() {} } } };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '' }; // Node 20

const { focusBack } = await import('../web/js/core/dom.js');

const box = () => {
  const el = { isConnected: true, focused: null, focus(o) { el.focused = o; document.activeElement = el; } };
  return el;
};

test('a box blurred on its way between sections gets the keys back', () => {
  const reply = box();
  document.activeElement = reply;
  const back = focusBack();
  document.activeElement = body; // the card left #secNeeds
  back(); // and arrived in #secWorking
  assert.equal(document.activeElement, reply);
  assert.deepEqual(reply.focused, { preventScroll: true }, 'the transcript stays where it was');
});

test('a focus moved on purpose meanwhile stands', () => {
  const reply = box();
  const launcher = box();
  document.activeElement = reply;
  const back = focusBack();
  document.activeElement = launcher;
  back();
  assert.equal(document.activeElement, launcher);
});

test('a box that left the page for good is let go', () => {
  const reply = box();
  document.activeElement = reply;
  const back = focusBack();
  reply.isConnected = false;
  document.activeElement = body;
  back();
  assert.equal(document.activeElement, body);
  assert.equal(reply.focused, null);
});

test('nothing focused before: nothing happens after', () => {
  document.activeElement = body;
  const back = focusBack();
  back();
  assert.equal(document.activeElement, body);
});
