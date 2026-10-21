// Signing in to a harness from the page (Settings → Agents): the CLI's own login under a terminal,
// its link and code read from what it prints, a code pasted back, and the login kept where the CLI
// keeps it (on a wisp Grid: the user's own home folder).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';

const home = tmp('login-home');
const bins = tmp('login-bin');
const FAKE = fileURLToPath(new URL('./fixtures/fake-login.mjs', import.meta.url));
for (const name of ['claude', 'codex', 'gh']) {
  const exe = path.join(bins, name);
  fs.copyFileSync(FAKE, `${exe}.mjs`);
  fs.writeFileSync(exe, `#!${process.execPath}\nprocess.argv[1] = ${JSON.stringify(exe)};\nawait import(${JSON.stringify(`file://${exe}.mjs`)});\n`);
  fs.chmodSync(exe, 0o755);
}
Object.assign(process.env, { HOME: home, WISP_HOME: tmp('login-wisp'), WISP_CLAUDE_BIN: path.join(bins, 'claude'), WISP_CODEX_BIN: path.join(bins, 'codex'), WISP_GH_BIN: path.join(bins, 'gh'), WISP_UPDATE_CHECK: '0', WISP_TELEMETRY: '0' });

const { parse, clean, LOGINS } = await import('../server/agent-login.js');
const { startServer } = await import('../server/index.js');

let srv;
let base;
before(async () => {
  const port = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => r(p));
    });
  });
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}/api`;
});
after(() => {
  srv.shutdown();
  srv.server?.close();
});

const api = async (p, method = 'GET', body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('what the real CLIs print becomes a link, a code, and "waiting for a code"', () => {
  const codex = '\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m9YF0-4VK4S\x1b[0m';
  assert.deepEqual(parse(codex), { url: 'https://auth.openai.com/codex/device', code: '9YF0-4VK4S', needsInput: false });
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=k8n';
  const claude = `If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
  assert.deepEqual(parse(claude), { url, code: '', needsInput: true });
  assert.equal(clean('\x1b[1mbold\x1b[0m\r\n'), 'bold\n');
});

test('Grok and Antigravity: their sign-in output and whether they are signed in', () => {
  const grok = 'To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=QWBN-4425\n\nConfirm this code in your browser:\n\n  QWBN-4425';
  assert.deepEqual(parse(grok), { url: 'https://accounts.x.ai/oauth2/device?user_code=QWBN-4425', code: 'QWBN-4425', needsInput: false });
  assert.equal(LOGINS.grok.signedIn('You are not authenticated.\n\nDefault model: grok-4.6'), false);
  assert.equal(LOGINS.grok.signedIn('You are logged in with grok.com.\n\nDefault model: grok-4.7'), true);
  const agy = 'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=1&state=x\n\nWaiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:';
  assert.deepEqual(parse(agy), { url: 'https://accounts.google.com/o/oauth2/auth?client_id=1&state=x', code: '', needsInput: true });
  assert.equal(LOGINS.antigravity.signedIn('Fetching available models...\nError: Please sign in to view available models.', 1), false);
  assert.equal(LOGINS.antigravity.signedIn('Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)', 0), true);
});

const agent = async (id, fresh = false) => (await api(`/agents${fresh ? '?fresh=1' : ''}`)).json.find((a) => a.id === id);

test('Claude: sign in with a pasted code; a wrong code fails with its message; the login stays in HOME', async () => {
  assert.equal((await api('/agents/claude/login')).json.signedIn, false);
  // Installed but signed out: not offered in the model picker.
  const before = await agent('claude', true);
  assert.equal(before.available, false);
  assert.equal(before.signedIn, false);
  await api('/agents/claude/login', 'POST');
  const w = await until(async () => {
    const v = (await api('/agents/claude/login')).json;
    return v.needsInput && v;
  }, 'the paste box');
  assert.equal(w.state, 'waiting');
  assert.match(w.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.equal((await api('/agents/claude/login/input', 'POST', { code: 'a\nb' })).status, 400);
  await api('/agents/claude/login/input', 'POST', { code: 'wrong' });
  const failed = await until(async () => {
    const v = (await api('/agents/claude/login')).json;
    return v.state === 'failed' && v;
  }, 'the failure');
  assert.match(failed.error, /Invalid code/);

  await api('/agents/claude/login', 'POST');
  await until(async () => (await api('/agents/claude/login')).json.needsInput, 'the paste box again');
  await api('/agents/claude/login/input', 'POST', { code: 'good-code' });
  const done = await until(async () => {
    const v = (await api('/agents/claude/login')).json;
    return v.state === 'done' && v;
  }, 'the sign-in');
  assert.equal(done.signedIn, true);
  assert.ok(fs.existsSync(path.join(home, '.fake-claude')), 'the CLI kept its login in HOME');
  // Signed in: wisp looks again by itself, and it's offered now.
  await until(async () => (await agent('claude')).available, 'claude in the picker');
});

test('Codex: a device code to enter on its page; done when the CLI says so; sign out', async () => {
  const started = (await api('/agents/codex/login', 'POST')).json;
  assert.ok(['running', 'waiting'].includes(started.state));
  const w = await until(async () => {
    const v = (await api('/agents/codex/login')).json;
    return v.code && v;
  }, 'the code');
  assert.equal(w.url, 'https://auth.openai.com/codex/device');
  assert.equal(w.code, '9YF0-4VK4S');
  assert.equal(w.needsInput, false);
  // Starting again while it waits is the same sign-in, not a second one.
  assert.equal((await api('/agents/codex/login', 'POST')).json.code, '9YF0-4VK4S');
  const done = await until(async () => {
    const v = (await api('/agents/codex/login')).json;
    return v.state === 'done' && v;
  }, 'codex signed in');
  assert.equal(done.signedIn, true);
  await until(async () => (await agent('codex')).available, 'codex in the picker');
  assert.equal((await api('/agents/codex/logout', 'POST')).json.signedIn, false);
  assert.equal((await api('/agents/codex/login')).json.signedIn, false);
  await until(async () => (await agent('codex')).available === false, 'codex out of the picker');
});

test('GitHub (gh): a device code; then git pushes with it and commits get your GitHub name', async () => {
  assert.equal((await api('/agents/gh/login')).json.signedIn, false);
  await api('/agents/gh/login', 'POST');
  const w = await until(async () => {
    const v = (await api('/agents/gh/login')).json;
    return v.code && v;
  }, 'the gh code');
  assert.equal(w.url, 'https://github.com/login/device');
  assert.equal(w.code, 'ABF2-20CC');
  await until(async () => (await api('/agents/gh/login')).json.signedIn, 'gh signed in');
  await until(() => fs.existsSync(path.join(home, '.gitconfig')) && /Octo Cat[\s\S]*email/.test(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')), 'the git identity');
  assert.ok(fs.existsSync(path.join(home, '.fake-gh-git')), 'gh auth setup-git ran');
  const cfg = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
  assert.match(cfg, /email = 583231\+octo@users\.noreply\.github\.com/);
  // gh isn't a harness: it never shows up in the model picker.
  assert.equal((await agent('gh')), undefined);
});

test('a harness wisp can’t sign in to says how', async () => {
  const r = await api('/agents/opencode/login', 'POST');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /terminal/);
});
