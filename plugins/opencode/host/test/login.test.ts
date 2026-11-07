// opencode's key sign-in data (v1 test/agent-login.test.js, test/sign-in.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { keys } from '../src/login.ts';

test('the key file: opencode’s data folder, XDG_DATA_HOME first', () => {
  assert.equal(keys.file({ XDG_DATA_HOME: '/d' }, '/home/u'), path.join('/d', 'opencode', 'auth.json'));
  assert.equal(keys.file({}, '/home/u'), path.join('/home/u', '.local', 'share', 'opencode', 'auth.json'));
  assert.deepEqual(keys.providers.map((p) => [p.id, p.name]), [['opencode', 'Zen'], ['opencode-go', 'Go']]);
  assert.equal(keys.url, 'https://opencode.ai/auth');
  assert.equal(keys.env, 'OPENCODE_API_KEY');
});

test('a bad key reads as signed out; no key at all can’t be told apart', () => {
  assert.equal(keys.authFailed.test('Upstream request failed: Invalid credential'), true);
  assert.equal(keys.authFailed.test('fake: not logged in (401)'), true);
  assert.equal(keys.authFailed.test('Unexpected server error'), false);
});
