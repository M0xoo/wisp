// Claude's sign-in data (v1 test/agent-login.test.js, test/sign-in.test.js, test/accounts.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accounts, login } from '../src/login.ts';

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${p}-`));

test('signed in or not, from `claude auth status` (JSON)', () => {
  assert.equal(login.signedIn(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }, null, 2), 0), true);
  assert.equal(login.signedIn('{"loggedIn": false, "authMethod": "none"}', 0), false);
  assert.equal(login.signedIn('something else', 1), null, 'an answer we don’t know hides nothing');
});

test('its real signed-out words, and ordinary failures that aren’t', () => {
  for (const t of [
    'Not logged in · Please run /login',
    'Login expired · Please run /login',
    'OAuth token revoked · Please run /login',
    'Login reached its time limit · Please run /login',
    'Authentication required · Sign in again to continue',
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Session expired. Please run /login to sign in again.',
    'API Error: 401 Invalid API key · Please run /login',
    'authentication_failed',
  ])
    assert.equal(login.authFailed.test(t), true, t);
  for (const t of ['Invalid API key · Fix external API key', 'fake: something broke (500)']) assert.equal(login.authFailed.test(t), false, t);
});

test('who a login is, from its status', async () => {
  assert.deepEqual(await login.whoIs?.('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}', {}), { email: 'a@b.c', plan: 'Max' });
  assert.deepEqual(await login.whoIs?.('Loading…\n{"loggedIn":true}', {}), { email: '', plan: '' });
  assert.deepEqual(await login.whoIs?.('not json', {}), {});
});

test('its folder: CLAUDE_CONFIG_DIR, else ~/.claude; the login is its own', () => {
  assert.equal(accounts.home({ CLAUDE_CONFIG_DIR: '/x/claude' }, '/home/u'), '/x/claude');
  assert.equal(accounts.home({}, '/home/u'), path.join('/home/u', '.claude'));
  assert.ok(accounts.own.includes('.credentials.json') && accounts.own.includes('.claude.json'));
  assert.equal(accounts.resumes, true);
  assert.equal(accounts.label, 'Claude');
});

test('.claude.json: an account’s copy gets your MCP servers, never who is signed in', async () => {
  const base = tmp('claude-base');
  const dir = tmp('claude-acc');
  fs.writeFileSync(path.join(base, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@corp.com' }, userID: 'u1', mcpServers: { db: { command: 'db-mcp' } }, hasCompletedOnboarding: true }));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@home' }, theme: 'dark' }));
  await accounts.sync({ dir, base, env: { CLAUDE_CONFIG_DIR: base }, userHome: tmp('claude-home') });
  const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.deepEqual(own.mcpServers, { db: { command: 'db-mcp' } });
  assert.equal(own.hasCompletedOnboarding, true);
  assert.deepEqual(own.oauthAccount, { emailAddress: 'me@home' }, 'its own login stays');
  assert.equal(own.userID, undefined);
  assert.equal(own.theme, 'dark');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777, 0o600);
  // Without CLAUDE_CONFIG_DIR, the default's file is ~/.claude.json, next to the folder.
  const home = tmp('claude-home2');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { web: { url: 'x' } } }));
  const dir2 = tmp('claude-acc2');
  await accounts.sync({ dir: dir2, base: path.join(home, '.claude'), env: {}, userHome: home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir2, '.claude.json'), 'utf8')), { mcpServers: { web: { url: 'x' } } });
});
