// wisp stops answering: the page says so once the stream has stayed down, and only then.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const classes = new Set();
const line = { hidden: true };
globalThis.document = {
  body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
  getElementById: (id) => (id === 'reconnecting' ? line : null),
};
const { streamDown, streamUp, WAIT } = await import('../web/js/features/reconnecting.js');
const shown = () => [!line.hidden, classes.has('stream-down')];

test.beforeEach(() => streamUp());

test('a dropped stream says nothing until it has stayed down', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  streamDown();
  t.mock.timers.tick(WAIT - 1);
  assert.deepEqual(shown(), [false, false]);
  t.mock.timers.tick(1);
  assert.deepEqual(shown(), [true, true]);
});

test('a blip that comes back in time never shows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  streamDown();
  t.mock.timers.tick(WAIT - 1);
  streamUp();
  t.mock.timers.tick(WAIT * 2);
  assert.deepEqual(shown(), [false, false]);
});

test('every failed retry leaves the wait where it was', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  streamDown();
  t.mock.timers.tick(WAIT - 1);
  streamDown(); // the browser's next retry fails too
  t.mock.timers.tick(1);
  assert.deepEqual(shown(), [true, true]);
});

test('the line goes as soon as the stream is back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  streamDown();
  t.mock.timers.tick(WAIT);
  streamUp();
  assert.deepEqual(shown(), [false, false]);
});

test('the page reports the stream going and coming back', () => {
  const live = fs.readFileSync(new URL('../web/js/features/live.js', import.meta.url), 'utf8');
  assert.match(live, /if \(this === es\) \{\s*syncing\(true\);\s*streamDown\(\);/);
  assert.match(live, /addEventListener\('hello', \(\) => \{\s*streamUp\(\);/);
  assert.match(fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), /id="reconnecting"[^>]*role="status"/);
});
