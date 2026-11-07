// Sandboxes (sandboxes.ts) without hostd or the edge: labels, their own bearer, the sign-ins and
// env vars every sandbox of a user starts with, and what goes when one is removed. A task in a real
// sandbox box through the edge: grid.test.ts.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { SANDBOX_ENV_MAX, SANDBOX_LABEL, createSandboxes } from '../src/sandboxes.ts';
import { createSecrets, ensureMaster } from '../src/secrets.ts';
import { tmp } from './helpers.ts';

const dbs: Db[] = [];
after(() => dbs.forEach((d) => d.close()));
const pia = { id: 'u1', handle: 'pia' };
const TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`;

async function boot(overrides: Record<string, unknown> = {}) {
  const dataDir = tmp('sandboxes');
  ensureMaster(dataDir);
  const db = await openDb(dataDir);
  dbs.push(db);
  for (const u of [pia, { id: 'u2', handle: 'dee' }]) db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', u.id, u.handle, Date.now());
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', ...overrides } });
  const secrets = createSecrets(db, { dataDir, env: {} });
  return { db, secrets, sb: createSandboxes({ db, cfg, secrets }) };
}

test('a sandbox: sb-<id>--<handle>, its own box id under its owner, a name cut to size, a label nobody has', async () => {
  const g = await boot();
  const seen: string[] = [];
  const { row, token } = g.sb.create(pia, '  fix   the\nlogin  ', { taken: (l) => (seen.push(l), seen.length < 2) });
  assert.equal(seen.length, 2, 'a taken label is drawn again');
  assert.match(row.label, /^sb-[a-f0-9]{8}--pia$/);
  assert.ok(SANDBOX_LABEL.test(row.label));
  assert.equal(row.name, 'fix the login');
  assert.ok(token.length > 20);
  assert.deepEqual(g.sb.box(row, pia), { id: `u1-sb-${row.id}`, handle: row.label, owner: 'u1', sandbox: row.id, ownerHandle: 'pia' });
  assert.deepEqual(g.sb.view(row), { id: row.id, name: 'fix the login', url: `http://${row.label}.wisp.localhost:8080`, createdAt: row.created_at });
  assert.equal(g.sb.create(pia, '').row.name, 'Sandbox');
  assert.equal(g.sb.byLabel(row.label.toUpperCase())?.id, row.id);
  assert.equal(g.sb.get('nothex!!'), null);
});

test('only its own bearer opens it: another sandbox’s secret, a typo or a device token don’t', async () => {
  const g = await boot();
  const a = g.sb.create(pia, 'a').row;
  const b = g.sb.create(pia, 'b').row;
  assert.equal(g.sb.byBearer(`Bearer ${g.sb.bearer(a)}`)?.id, a.id);
  const secretB = g.sb.bearer(b).split('_')[2];
  assert.equal(g.sb.byBearer(`Bearer wsb_${a.id}_${secretB}`), null);
  assert.equal(g.sb.byBearer(`Bearer ${g.sb.bearer(a)}x`), null);
  assert.equal(g.sb.byBearer('Bearer wgd_abc'), null);
  assert.equal(g.sb.byBearer(undefined), null);
  assert.notEqual(g.sb.proxySecret(a), g.sb.proxySecret(b));
  assert.equal(g.sb.proxySecret(a), g.sb.proxySecret({ id: a.id, user_id: 'u1' }), 'made once, sealed under the owner');
  g.sb.remove(a);
  assert.equal(g.sb.byBearer(`Bearer ${g.sb.bearer(b)}`)?.id, b.id);
  assert.equal(g.sb.get(a.id), null);
  assert.equal(g.secrets.open('u1', `sandbox:${a.id}`), null);
  assert.equal(g.secrets.open('u1', `wisp-proxy:sb:${a.id}`), null);
});

test('sign-ins: Claude’s setup token only, kept per user, in every sandbox’s env and never shown', async () => {
  const g = await boot();
  assert.deepEqual(g.sb.logins('u1'), { claude: false });
  assert.throws(() => g.sb.setLogin('u1', 'codex', TOKEN), /Claude only/);
  assert.throws(() => g.sb.setLogin('u1', 'claude', 'sk-ant-api03-x'), /isn’t a Claude token/);
  g.sb.setLogin('u1', 'claude', ` ${TOKEN} `);
  assert.deepEqual(g.sb.logins('u1'), { claude: true });
  assert.deepEqual(g.sb.logins('u2'), { claude: false }, 'another user’s sandboxes start without it');
  assert.deepEqual(g.sb.envFor('u1'), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  g.sb.dropLogin('u1', 'claude');
  assert.deepEqual(g.sb.envFor('u1'), {});
  assert.throws(() => g.sb.dropLogin('u1', 'nope'), (e: Error & { status?: number }) => e.status === 404);
});

test('env vars: names back never values, wisp’s own refused, one line up to 8 KB, at most 40', async () => {
  const g = await boot();
  g.sb.setEnv('u1', ' DATABASE_URL ', 'postgres://x');
  g.sb.setEnv('u1', 'API_KEY', 'k');
  assert.deepEqual(g.sb.envKeys('u1'), ['API_KEY', 'DATABASE_URL']);
  for (const k of ['1X', 'A-B', '', 'x'.repeat(65)]) assert.throws(() => g.sb.setEnv('u1', k, 'v'), /A name like DATABASE_URL/, k);
  for (const k of ['WISP_X', 'PATH', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.throws(() => g.sb.setEnv('u1', k, 'v'), /wisp’s own/, k);
  for (const v of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(8193)]) assert.throws(() => g.sb.setEnv('u1', 'OK', v), /one line/);
  g.sb.setLogin('u1', 'claude', TOKEN);
  assert.deepEqual(g.sb.envFor('u1'), { API_KEY: 'k', DATABASE_URL: 'postgres://x', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, 'the sign-in wins over a var');
  for (let i = g.sb.envKeys('u1').length; i < SANDBOX_ENV_MAX; i++) g.sb.setEnv('u1', `V${i}`, 'x');
  assert.throws(() => g.sb.setEnv('u1', 'ONE_MORE', 'x'), /Up to 40/);
  g.sb.setEnv('u1', 'API_KEY', 'changed'); // replacing one isn't one more
  g.sb.dropEnv('u1', 'API_KEY');
  assert.ok(!g.sb.envKeys('u1').includes('API_KEY'));
  for (const k of g.sb.envKeys('u1')) g.sb.dropEnv('u1', k);
  assert.equal(g.secrets.open('u1', 'sandbox-env'), null, 'the last one gone takes the sealed row too');
});

test('perUser and switched off', async () => {
  const g = await boot({ sandboxes: { perUser: 2 } });
  g.sb.create(pia, 'a');
  g.sb.create(pia, 'b');
  assert.throws(() => g.sb.create(pia, 'c'), (e: Error & { status?: number }) => e.status === 409 && /You have 2 sandboxes/.test(e.message));
  assert.equal(g.sb.list('u1').length, 2);
  const off = await boot({ sandboxes: { enabled: false } });
  assert.throws(() => off.sb.create(pia, 'a'), (e: Error & { status?: number }) => e.status === 403);
});
