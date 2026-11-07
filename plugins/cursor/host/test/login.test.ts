// Cursor's sign-in data (v1 test/sign-in.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../src/login.ts';

test('signed in or not, from `cursor-agent status`', () => {
  assert.equal(login.signedIn('Logged in as a@b.c', 0), true);
  assert.equal(login.signedIn('Not logged in', 1), false);
  assert.equal(login.signedIn('', 0), null);
});

test('its real signed-out words', () => {
  assert.equal(login.authFailed.test("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."), true);
  assert.equal(login.authFailed.test('Not logged in'), true);
  assert.equal(login.authFailed.test('fake: something broke (500)'), false);
  assert.deepEqual(login.extraEnv, { NO_OPEN_BROWSER: '1' });
});
