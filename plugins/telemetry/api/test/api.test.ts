// The pure parts of the contract: page events (v1 test/feedback.test.js) and errors as plain data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorInfo, pageEvent, TELEMETRY } from '../src/index.ts';

test('page events: only the listed ones, with only their allowed values', () => {
  assert.deepEqual(pageEvent('getapp_opened', { from: 'button', email: 'a@b.c' }), { from: 'button' });
  assert.deepEqual(pageEvent('getapp_opened', { from: '/Users/me/secret' }), {});
  assert.deepEqual(pageEvent('getapp_clicked', { anything: 'x' }), {});
  assert.equal(pageEvent('prompt_typed', { text: 'hi' }), null);
  assert.equal(pageEvent('__proto__'), null);
  assert.equal(pageEvent('toString'), null);
  assert.equal(pageEvent(42), null);
});

test('errorInfo: an Error by its parts, anything else as its text', () => {
  const e = new TypeError('nope');
  assert.deepEqual({ ...errorInfo(e), stack: undefined }, { name: 'TypeError', message: 'nope', stack: undefined });
  assert.match(String(errorInfo(e).stack), /TypeError: nope/);
  assert.deepEqual(errorInfo('plain'), { message: 'plain' });
});

test('every service method maps to a permission', () => {
  for (const m of ['track', 'captureError', 'enabled', 'startupNotice']) assert.match(TELEMETRY.permissions[m as keyof typeof TELEMETRY.permissions], /^telemetry:/);
});
