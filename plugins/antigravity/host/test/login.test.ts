// Antigravity's sign-in data (v1 test/agent-login.test.js, test/sign-in.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetAgy, login } from '../src/login.ts';

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${p}-`));

test('whether it is signed in, from `agy models`', () => {
  assert.equal(login.signedIn('Fetching available models...\nError: Please sign in to view available models.', 1), false);
  assert.equal(login.signedIn('Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)', 0), true);
  assert.equal(login.signedIn('Fetching available models...', 1), null);
  assert.equal(login.tty, true, 'it only asks on a terminal');
});

test('its real signed-out words', () => {
  assert.equal(login.authFailed.test('authentication failed or timed out'), true);
  assert.equal(login.authFailed.test("Error: authentication required. Run 'agy' to log in, then retry."), true);
  assert.equal(login.authFailed.test('fake: something broke (500)'), false);
});

test('sign out: its login file goes (agy has no logout command); the keychain item on macOS', async () => {
  const h = tmp('agy-home');
  const token = path.join(h, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, '{}');
  const ran: string[][] = [];
  const exec = async (bin: string, args: readonly string[]) => (ran.push([bin, ...args]), { code: 0, stdout: '', stderr: '' });
  await forgetAgy({ home: h, platform: 'linux', exec });
  assert.equal(fs.existsSync(token), false);
  await forgetAgy({ home: h, platform: 'linux', exec }); // already signed out: fine
  assert.deepEqual(ran, [], 'no keychain on Linux');
  await forgetAgy({ home: h, platform: 'darwin', exec });
  assert.deepEqual(ran, [['security', 'delete-generic-password', '-s', 'gemini', '-a', 'antigravity']]);
  assert.equal(typeof login.logout, 'function');
});
