// Codex's sign-in data (v1 test/agent-login.test.js, test/sign-in.test.js, test/accounts.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accounts, login } from '../src/login.ts';

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${p}-`));

test('signed in or not, from `codex login status`', () => {
  assert.equal(login.signedIn('Logged in using ChatGPT', 0), true);
  assert.equal(login.signedIn('Not logged in', 1), false);
  assert.equal(login.signedIn('', 1), null);
});

test('its real signed-out words, and ordinary failures that aren’t', () => {
  for (const t of [
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses',
    'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
    'Your access token could not be refreshed. Please sign in again.',
    'no Codex credentials were found',
    'Run codex login to continue',
    '{"code":"refresh_token_invalidated"}',
  ])
    assert.equal(login.authFailed.test(t), true, t);
  assert.equal(login.authFailed.test('unexpected status 500 Internal Server Error'), false);
});

test('who a login is, from the id token in auth.json', async () => {
  const home = tmp('codex');
  const claims = Buffer.from(JSON.stringify({ email: 'x@y.z', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `h.${claims}.s` } }));
  assert.deepEqual(await login.whoIs?.('Logged in using ChatGPT', { CODEX_HOME: home }), { email: 'x@y.z', plan: 'Plus' });
  assert.deepEqual(await login.whoIs?.('', { CODEX_HOME: tmp('codex-none') }), {});
});

test('its folder: CODEX_HOME, else ~/.codex; conversations stay with the login', () => {
  assert.equal(accounts.home({ CODEX_HOME: '/x/codex' }, '/home/u'), '/x/codex');
  assert.equal(accounts.home({}, '/home/u'), path.join('/home/u', '.codex'));
  assert.ok(accounts.own.includes('auth.json'));
  assert.equal(accounts.resumes, false);
  assert.deepEqual(accounts.dirs, ['sessions']);
  assert.equal(accounts.label, 'Codex');
});
