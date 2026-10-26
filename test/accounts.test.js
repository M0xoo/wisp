// Several accounts per harness (server/accounts.js): each is a login folder linked to the CLI's
// own for everything but the login; runs get it in their env; a usage limit asks you what next and
// never switches accounts by itself (the providers' terms, design/accounts.md).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const { Accounts } = await import('../server/accounts.js');
const { whoIs } = await import('../server/agent-login.js');
const { missedTurns } = await import('../server/handoff.js');

const setup = () => {
  const wisp = tmp('acc-wisp');
  const claude = tmp('acc-claude');
  fs.mkdirSync(path.join(claude, 'skills'));
  fs.writeFileSync(path.join(claude, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(claude, '.credentials.json'), '{"secret":1}');
  fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@corp.com' }, userID: 'u1', mcpServers: { db: { command: 'db-mcp' } }, hasCompletedOnboarding: true }));
  let now = 1_000_000;
  const a = new Accounts(wisp, { env: { CLAUDE_CONFIG_DIR: claude }, userHome: tmp('acc-home'), now: () => now });
  return { a, wisp, claude, tick: (ms) => (now += ms) };
};

test('one account: nothing to choose, no env, nothing stored', () => {
  const { a, wisp } = setup();
  assert.equal(a.multi('claude'), false);
  assert.equal(a.pick('claude'), '');
  assert.deepEqual(a.envFor('claude', 'default'), {});
  assert.deepEqual(a.view('claude').map((x) => x.id), ['default']);
  assert.deepEqual(a.list('cursor'), [], 'only harnesses with a login folder');
  assert.equal(fs.existsSync(path.join(wisp, 'accounts.json')), false);
  assert.throws(() => a.add('cursor'), /can’t have more than one account/);
});

test('an extra account links everything but the login, and keeps your MCP servers', () => {
  const { a, wisp, claude } = setup();
  const acc = a.add('claude', 'Personal');
  const dir = path.join(wisp, 'accounts', 'claude', acc.id);
  assert.equal(a.multi('claude'), true);
  assert.deepEqual(a.envFor('claude', acc.id), { CLAUDE_CONFIG_DIR: dir });
  assert.deepEqual(a.envFor('claude', 'default'), {}, 'the CLI’s own folder needs nothing');
  for (const name of ['skills', 'settings.json', 'projects']) assert.ok(fs.lstatSync(path.join(dir, name)).isSymbolicLink(), name);
  assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false, 'the login is never shared');
  a.prepare('claude', acc.id);
  assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false, 'not on a repair either');
  assert.ok(fs.existsSync(path.join(claude, 'projects')), 'transcripts folder made first, so the link isn’t dangling');
  const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.deepEqual(own.mcpServers, { db: { command: 'db-mcp' } });
  assert.equal(own.hasCompletedOnboarding, true);
  assert.equal(own.oauthAccount, undefined);
  assert.equal(own.userID, undefined);
  // A CLI's atomic write turned the link into a file: the newer one wins, then it's a link again.
  fs.unlinkSync(path.join(dir, 'settings.json'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"light"}');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'settings.json'), later, later);
  a.prepare('claude', acc.id);
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'), '{"theme":"light"}');
});

test('a Codex account never gets the other login’s auth.json', () => {
  const wisp = tmp('acc-wisp');
  const codex = tmp('acc-codex-home');
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"tokens":{}}');
  fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "x"');
  const a = new Accounts(wisp, { env: { CODEX_HOME: codex }, userHome: tmp('acc-home') });
  const acc = a.add('codex', 'Side');
  const dir = path.join(wisp, 'accounts', 'codex', acc.id);
  assert.deepEqual(a.envFor('codex', acc.id), { CODEX_HOME: dir });
  assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
  assert.ok(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink(), 'transcripts shared');
});

test('order, pick, limits and removal', () => {
  const { a, wisp, tick } = setup();
  const b = a.add('claude', 'Personal');
  const c = a.add('claude', '');
  assert.deepEqual(a.view('claude').map((x) => x.id), ['default', b.id, c.id]);
  assert.equal(a.get('claude', 'default').label, 'Main');
  assert.equal(a.pick('claude'), 'default', 'the first in your order');
  assert.equal(a.pick('claude', c.id), c.id, 'your pick');
  a.cool('claude', 'default', { ms: 60_000, why: 'session limit' });
  assert.equal(a.get('claude', 'default').state, 'limit');
  assert.equal(a.pick('claude', '', { byHand: true }), b.id, 'started by hand: skips one already at its limit');
  assert.equal(a.pick('claude'), 'default', 'unattended: your pick as it is, never routed round a limit');
  a.cool('claude', b.id, { ms: 30_000 });
  a.cool('claude', c.id, { ms: 90_000 });
  assert.equal(a.pick('claude', c.id, { byHand: true }), c.id, 'all at their limit: your pick anyway');
  tick(61_000);
  assert.equal(a.pick('claude', '', { byHand: true }), 'default', 'free again after its reset');
  assert.equal(a.get('claude', b.id).kind, 'personal');
  a.identify('claude', b.id, { plan: 'Team' });
  assert.equal(a.get('claude', b.id).kind, 'work', 'a Team plan is a work account');
  a.update('claude', b.id, { kind: 'personal' });
  assert.equal(a.get('claude', b.id).kind, 'personal', 'your choice wins over the guess');
  assert.throws(() => a.update('claude', b.id, { kind: 'shared' }), /kind must be one of personal, work/);
  a.identify('claude', c.id, { email: 'me@gmail.com', plan: 'Pro', signedIn: true });
  assert.equal(a.get('claude', c.id).label, 'Me', 'unnamed: from the email');
  assert.equal(a.get('claude', c.id).state, 'ready', 'signing in clears its limit');
  assert.deepEqual(a.update('claude', c.id, { move: 'up', label: 'Side' }).map((x) => x.id), ['default', c.id, b.id]);
  assert.throws(() => a.remove('claude', 'default'), /sign out of it instead/);
  // Reloaded from disk: same list.
  assert.deepEqual(new Accounts(wisp, { env: a.env, userHome: a.userHome }).view('claude').map((x) => x.label), ['Main', 'Side', 'Personal']);
  a.remove('claude', b.id);
  assert.equal(fs.existsSync(path.join(wisp, 'accounts', 'claude', b.id)), false);
  a.remove('claude', c.id);
  assert.equal(a.multi('claude'), false, 'back to just the CLI’s own');
  assert.equal(JSON.parse(fs.readFileSync(path.join(wisp, 'accounts.json'), 'utf8')).claude, undefined);
});

test('who a login is, from claude’s status and codex’s id token', () => {
  assert.deepEqual(whoIs('claude', '{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}'), { email: 'a@b.c', plan: 'Max' });
  const home = tmp('acc-codex');
  const claims = Buffer.from(JSON.stringify({ email: 'x@y.z', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `h.${claims}.s` } }));
  assert.deepEqual(whoIs('codex', 'Logged in using ChatGPT', { CODEX_HOME: home }), { email: 'x@y.z', plan: 'Plus' });
  assert.deepEqual(whoIs('codex', '', { CODEX_HOME: tmp('acc-none') }), {});
});

test('a harness whose conversations stay with the login counts the other account’s turns as missed', () => {
  const s = { turns: [{ agent: 'codex', account: 'default' }, { agent: 'codex', account: 'b' }] };
  assert.deepEqual(missedTurns(s, 'codex', null), [], 'same harness: nothing to catch up on');
  const mine = (t) => t.agent === 'codex' && (t.account || 'default') === 'b';
  assert.equal(missedTurns(s, 'codex', null, mine).length, 1);
});

// --- through the server, with the fake harnesses ---------------------------------------------

const RECORD = tmp('acc-record');
const CLAUDE_HOME = tmp('acc-claude-home');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('acc-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME; // never this computer's ~/.claude
installFakeBins();
const { startServer } = await import('../server/index.js');
let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const settled = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state === 'review' && x;
}, { timeout: 30_000 });

before(async () => {
  // Two Claude accounts before wisp starts: the CLI's own, then Personal.
  fs.writeFileSync(path.join(process.env.WISP_HOME, 'accounts.json'), JSON.stringify({ claude: [{ id: 'default', label: 'Work' }, { id: 'pers', label: 'Personal' }] }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('the harness list carries its accounts; a launch runs on the account you pick', async () => {
  const claude = (await api('/agents')).find((a) => a.id === 'claude');
  assert.deepEqual(claude.accounts.map((a) => [a.id, a.label, a.state]), [['default', 'Work', 'ready'], ['pers', 'Personal', 'ready']]);
  assert.equal(claude.accounts[0].home, undefined, 'no folders for the page');
  assert.equal((await api('/agents')).find((a) => a.id === 'cursor-agent' || a.id === 'cursor')?.accounts, undefined);
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd: makeRepo(), agent: 'claude', account: 'pers', worktree: false });
  assert.equal(s.account, 'pers');
  const done = await settled(s.id);
  assert.equal(done.turns[0].account, 'pers');
  const run = records(RECORD, 'claude').find((r) => r.stdin.includes('fix the add bug') && r.configDir !== CLAUDE_HOME);
  assert.equal(run.configDir, path.join(process.env.WISP_HOME, 'accounts', 'claude', 'pers'));
  // A follow-up on the other account: the CLI's own folder (CLAUDE_CONFIG_DIR as wisp got it).
  await api(`/sessions/${s.id}/reply`, { text: 'and the docs', account: 'default' });
  const next = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 2 && x.state === 'review' && x;
  });
  assert.equal(next.account, 'default');
  assert.equal(records(RECORD, 'claude').findLast((r) => r.stdin.includes('and the docs')).configDir, CLAUDE_HOME);
});

test('a usage limit asks what next: wisp never moves the task to another account by itself', async () => {
  const marker = path.join(tmp('acc-limit'), 'hit');
  process.env.FAKE_LIMIT_ONCE = marker;
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', account: 'default', worktree: false });
    const stopped = await settled(s.id);
    assert.equal(stopped.turns.length, 1, 'no follow-up of its own');
    assert.equal(stopped.account, 'default');
    const t = stopped.turns[0];
    assert.equal(t.status, 'error');
    assert.equal(t.limit.account, 'default');
    assert.deepEqual(t.limit.others, [{ id: 'pers', label: 'Personal', kind: 'personal' }]);
    assert.match(t.limit.extra, /^https:\/\/support\.claude\.com\//);
    assert.equal(t.presentation.blocks[0].title, 'Work is at its usage limit');
    assert.ok(t.limit.until > Date.now(), 'the card says when, in the page’s format');
    assert.equal((await api('/agents')).find((a) => a.id === 'claude').accounts.find((a) => a.id === 'default').state, 'limit');
    // You pick: continue on Personal, in the same conversation.
    await api(`/sessions/${s.id}/reply`, { text: 'carry on', account: 'pers' });
    const next = await until(async () => {
      const x = await api(`/sessions/${s.id}`);
      return x.turns.length === 2 && x.state === 'review' && x;
    });
    assert.equal(next.account, 'pers');
    assert.equal(next.turns[1].status, 'done');
    // Started by hand while Work is at its limit: Personal (unattended launches keep your pick: see pick()).
    const byHand = await api('/sessions', { prompt: 'another one', cwd: makeRepo(), agent: 'claude', worktree: false });
    assert.equal(byHand.account, 'pers');
    await settled(byHand.id);
  } finally {
    delete process.env.FAKE_LIMIT_ONCE;
  }
});

test('accounts are managed through the API: rename, reorder, remove; the default stays', async () => {
  await assert.rejects(api('/agents/claude/accounts/default', {}, 'DELETE'), /sign out of it instead/);
  let { accounts } = await api('/agents/claude/accounts/pers', { label: 'Home', move: 'up' }, 'PATCH');
  assert.deepEqual(accounts.map((a) => a.label), ['Home', 'Work']);
  ({ accounts } = await api('/agents/claude/accounts/pers', {}, 'DELETE'));
  assert.deepEqual(accounts.map((a) => a.id), ['default']);
  await assert.rejects(api('/agents/claude/accounts/nope', { label: 'x' }, 'PATCH'), /No such account/);
});
