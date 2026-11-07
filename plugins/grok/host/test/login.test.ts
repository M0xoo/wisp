// Grok's sign-in data (v1 test/agent-login.test.js, test/sign-in.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../src/login.ts';

test('whether it is signed in, from `grok models`', () => {
  assert.equal(login.signedIn('You are not authenticated.\n\nDefault model: grok-4.6', 1), false);
  assert.equal(login.signedIn('You are logged in with grok.com.\n\nDefault model: grok-4.7', 0), true);
  assert.equal(login.signedIn('Default model: grok-4.7', 0), null);
});

test('its real signed-out words, and an ordinary failure that isn’t', () => {
  for (const t of ['Not signed in. To authenticate without a browser, run:\n  grok login --device-code', 'Session expired. Run `grok login` to re-authenticate.', 'Authentication required. Run `grok login` to re-authenticate.', 'Run /login to re-authenticate'])
    assert.equal(login.authFailed.test(t), true, t);
  assert.equal(login.authFailed.test('Session expired (HTTP 404)'), false);
});
