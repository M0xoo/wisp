// Shared tasks (shares.ts) without the edge: what a share keeps, its passkey, its card, its media and
// its pack. The page at /s/<id>, the import API and the passkey cookie: grid.test.ts.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { packDir } from '../src/shared/bundle.ts';
import { PASSKEY_MAX, SHARE_ID, checkPasskey, createShares, hashPasskey, shareMeta } from '../src/shares.ts';
import { write } from './bundle-helpers.ts';
import { tmp } from './helpers.ts';

const dbs: Db[] = [];
after(() => dbs.forEach((d) => d.close()));
const pia = { id: 'u1', handle: 'pia', name: 'Pia', avatar: null, email: null, created_at: 0, disabled: 0 };

async function boot(overrides: Record<string, unknown> = {}) {
  const dataDir = tmp('shares');
  const db = await openDb(dataDir);
  dbs.push(db);
  db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', pia.id, pia.handle, Date.now());
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', ...overrides } });
  return { dataDir, db, shares: createShares({ db, cfg }) };
}

const TASK = { wispTask: 1, title: 'Fix the login', agent: 'claude', model: 'opus', turns: [{ startedAt: 1, endedAt: 5 }, { startedAt: 6, endedAt: 9 }], work: { kind: 'git', repo: 'acme/web', branch: 'fix', changed: 3 }, connectors: [{ name: 'Linear' }], kit: [{ name: 'review' }], subagents: [{}, {}], runs: { r1: {} }, crew: { members: [{ name: 'Ada' }] } };
const bundle = async (task: unknown = TASK, more: Record<string, string> = {}) => (await packDir(write(tmp('share-src'), { 'task.json': JSON.stringify(task), ...more }))).body;

test('a passkey is kept as an scrypt hash: right opens, wrong, empty or none don’t; no passkey opens to anyone', async () => {
  const kept = await hashPasskey('open sesame');
  assert.match(kept, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.notEqual(await hashPasskey('open sesame'), kept, 'a salt of its own each time');
  assert.equal(await checkPasskey(kept, 'open sesame'), true);
  assert.equal(await checkPasskey(kept, 'open sesam'), false);
  assert.equal(await checkPasskey(kept, ''), false);
  assert.equal(await checkPasskey(kept, undefined), false);
  assert.equal(await checkPasskey('garbage', 'x'), false);
  assert.equal(await checkPasskey(null, ''), true);
});

test('shareMeta: what the card says, each field cut to size, from whatever task.json holds', () => {
  assert.deepEqual(shareMeta(TASK), { title: 'Fix the login', agent: 'claude', model: 'opus', effort: '', mode: '', turns: 2, lastAt: 9, work: { kind: 'git', repo: 'acme/web', branch: 'fix', changed: 3 }, connectors: ['Linear'], skills: ['review'], team: 2, delegates: 1, crew: ['Ada'] });
  const odd = shareMeta({ title: 'x'.repeat(500), turns: 'no', work: { kind: 'files' }, connectors: [{ name: 1 }, null, 'x'] });
  assert.equal(odd.title.length, 200);
  assert.deepEqual([odd.turns, odd.work?.kind, odd.connectors, odd.lastAt], [0, 'files', ['1'], null]);
  assert.equal(shareMeta(null).title, 'Shared task');
});

test('share: a 16-character link, updated in place by key, its passkey kept, set, cleared or left as it was', async () => {
  const g = await boot();
  const v = await g.shares.share(pia, 't1', await bundle(), { passkey: 'pk' });
  assert.match(v.id, SHARE_ID);
  assert.equal(v.url, `http://wisp.localhost:8080/s/${v.id}`);
  assert.equal(v.locked, true);
  const row = () => g.shares.get(v.id) ?? assert.fail('no row');
  assert.equal(await g.shares.unlocks(row(), 'pk'), true);
  assert.equal(await g.shares.unlocks(row(), 'nope'), false);
  const again = await g.shares.share(pia, 't1', await bundle({ ...TASK, title: 'Renamed' }));
  assert.deepEqual([again.id, again.locked, again.title], [v.id, true, 'Renamed'], 'undefined keeps the passkey');
  assert.equal((await g.shares.share(pia, 't1', await bundle(), { passkey: '' })).locked, false);
  assert.equal(await g.shares.unlocks(row(), ''), true);
  assert.equal(g.shares.list(pia.id).length, 1);
  const card = g.shares.card(row(), pia);
  assert.deepEqual([card.from, card.turns, card.locked, 'pass' in card], [{ handle: 'pia', name: 'Pia', avatar: '' }, 2, false, false]);
  assert.equal(g.shares.get('short'), null);
  assert.equal(g.shares.get('A'.repeat(16)), null);
});

test('share refuses what isn’t a task, a bad key, a long passkey; a refusal leaves nothing behind', async () => {
  const g = await boot();
  await assert.rejects(g.shares.share(pia, 't1', await bundle({ turns: [] })), /isn’t a task wisp can share: not a shared task/);
  await assert.rejects(g.shares.share(pia, 't1', await packDir(write(tmp('no-task'), { 'a.txt': 'x' })).then((p) => p.body)), /isn’t a task wisp can share/);
  await assert.rejects(g.shares.share(pia, '../x', await bundle()), /Bad task key/);
  await assert.rejects(g.shares.share(pia, 't1', await bundle(), { passkey: 'x'.repeat(PASSKEY_MAX + 1) }), /at most 128/);
  const root = path.join(g.dataDir, 'shares');
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
});

test('the page reads task.json; media only by its own names; the pack is the folder again', async () => {
  const g = await boot();
  const v = await g.shares.share(pia, 't1', await bundle(TASK, { 'media/1.png': 'PNG', 'work.bundle': 'git', 'files/a.txt': 'a' }));
  const row = g.shares.get(v.id) ?? assert.fail('no row');
  assert.equal((await g.shares.task(row))['title'], 'Fix the login');
  assert.equal(await g.shares.media(row, '1.png'), path.join(g.dataDir, 'shares', v.id, 'media', '1.png'));
  for (const bad of ['2.png', '1.exe', '../task.json', 'x.png', '1.png/..']) assert.equal(await g.shares.media(row, bad), null, bad);
  const back = path.join(tmp('share-back'), 'x');
  const { unpackTo } = await import('../src/shared/bundle.ts');
  await unpackTo(await g.shares.pack(row), back);
  assert.deepEqual((fs.readdirSync(back, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).sort(), ['files', 'files/a.txt', 'media', 'media/1.png', 'task.json', 'work.bundle']);
});

test('perUser and switched off; remove and removeAll take the files too', async () => {
  const g = await boot({ shares: { perUser: 1 } });
  const v = await g.shares.share(pia, 't1', await bundle());
  await assert.rejects(g.shares.share(pia, 't2', await bundle()), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(await g.shares.remove(pia.id, 'nope'), false);
  assert.equal(await g.shares.remove(pia.id, 't1'), true);
  assert.equal(fs.existsSync(path.join(g.dataDir, 'shares', v.id)), false);
  await g.shares.share(pia, 't2', await bundle());
  await g.shares.removeAll(pia.id);
  assert.deepEqual([g.shares.list(pia.id).length, fs.readdirSync(path.join(g.dataDir, 'shares'))], [0, []]);
  const off = await boot({ shares: { enabled: false } });
  await assert.rejects(off.shares.share(pia, 't1', await bundle()), (e: Error & { status?: number }) => e.status === 403);
});
