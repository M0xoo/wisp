// Published apps (sites.ts) without the edge: a db, the config, and sites.serve behind a bare HTTP
// server. Through the edge (the link at <slug>--app--<handle>, tls-ask, the account page): grid.test.ts.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import type { SiteRow } from '../src/rows.ts';
import { packDir } from '../src/shared/bundle.ts';
import { SITE_LABEL, createSites, readRaw, siteSlug, type Sites } from '../src/sites.ts';
import { entry, write } from './bundle-helpers.ts';
import { browser, listen, tmp, until } from './helpers.ts';

const open: { db: Db; sites: Sites; srv: http.Server }[] = [];
after(() => {
  for (const o of open) {
    o.srv.close();
    o.sites.close();
    o.db.close();
  }
});

const user = { id: 'u1', handle: 'pia' };

// A grid's sites, served at `base` by label: the Host header is ignored, ?l=<label> picks the app.
async function boot(overrides: Record<string, unknown> = {}) {
  const dataDir = tmp('sites');
  const db = await openDb(dataDir);
  db.run('INSERT INTO users (id, email, handle, created_at) VALUES (?, ?, ?, ?)', user.id, 'pia@example.com', user.handle, Date.now());
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', ...overrides } });
  const sites = createSites({ db, cfg });
  let current: SiteRow | null = null;
  const srv = http.createServer((req, res) => {
    if (!current) return res.writeHead(404).end();
    sites.serve(req, res, current).catch(() => res.destroy());
  });
  const base = await listen(srv);
  open.push({ db, sites, srv });
  const at = (key: string): string => {
    current = db.get<SiteRow>('SELECT * FROM sites WHERE key = ?', key) ?? null;
    return `${base}/`;
  };
  return { dataDir, db, sites, at, dir: (key: string) => path.join(dataDir, 'sites', db.get<{ id: string }>('SELECT id FROM sites WHERE key = ?', key)?.id ?? '') };
}

test('siteSlug: a DNS label part, never a preview’s p<port>; SITE_LABEL has three parts', () => {
  assert.equal(siteSlug('Pia’s Slides!'), 'pia-s-slides');
  assert.equal(siteSlug('Crème brûlée'), 'creme-brulee');
  assert.equal(siteSlug(''), 'app');
  assert.equal(siteSlug('p5173'), 'p5173-app');
  assert.equal(siteSlug('a'.repeat(40)).length, 24);
  assert.ok(SITE_LABEL.test('pia-s-slides--app--pia'));
  assert.ok(!SITE_LABEL.test('laptop--pia'));
});

test('publish: a link by title, updated in place by key, refused without its entry or outside its folder', async () => {
  const g = await boot();
  const src = write(tmp('site-src'), { 'index.html': '<h1>v1</h1>', 'js/app.js': 'console.log(1)' });
  const v1 = await g.sites.publish(user, 'k1', (await packDir(src)).body, { title: 'Pia’s Slides!' });
  assert.equal(v1.url, 'http://pia-s-slides--app--pia.wisp.localhost:8080/');
  assert.deepEqual([v1.files, v1.title], [2, 'Pia’s Slides!']);
  const b = browser();
  const url = g.at('k1');
  assert.equal((await b.go(url)).text, '<h1>v1</h1>');
  assert.equal((await b.go(`${url}js/app.js`)).text, 'console.log(1)');
  assert.equal((await b.go(`${url}..%2f..%2fgrid.db`)).status, 404);
  assert.equal((await b.go(url, { method: 'POST', body: {} })).status, 405);
  write(src, { 'index.html': '<h1>v2</h1>' });
  const v2 = await g.sites.publish(user, 'k1', (await packDir(src)).body, { title: 'Pia’s Slides!' });
  assert.equal(v2.url, v1.url, 'the same link');
  assert.equal((await b.go(g.at('k1'))).text, '<h1>v2</h1>');
  assert.equal(g.sites.list(user.id).length, 1);
  await assert.rejects(g.sites.publish(user, 'evil', entry({ path: '../x.html', size: 0 })), (e: Error & { status?: number }) => e.status === 400);
  const noEntry = write(tmp('site-noentry'), { 'readme.md': 'hi' });
  await assert.rejects(g.sites.publish(user, 'evil', (await packDir(noEntry)).body), /No index\.html/);
  await assert.rejects(g.sites.publish(user, 'bad key!', (await packDir(src)).body), /Bad app key/);
  const again = await g.sites.publish(user, 'k2', (await packDir(src)).body, { title: 'Pia’s Slides!' });
  assert.match(again.url, /pia-s-slides-2--app--pia/, 'a second app with the same title gets the next label');
  assert.equal(fs.readdirSync(path.join(g.dataDir, 'sites')).filter((f) => f.includes('.new-')).length, 0);
});

test('the grid keeps secrets out of a published app, whatever an older wisp sent', async () => {
  const g = await boot();
  const src = write(tmp('old-client'), { 'index.html': 'hello', '.env': 'A=1', '.env.local': 'B=2', '.htaccess': 'x', '.config/a.json': '{}', 'sub/.env': 'C=3', 'sub/tls.key': 'k', 'server.pem': 'p', 'credentials.json': '{}', 'app.js': '1', 'app.js.map': '{}', '.well-known/assetlinks.json': '[]' });
  // What a 0.57.0 wisp sends: packDir with no filter.
  const out = await g.sites.publish(user, 'old1', (await packDir(src)).body, { title: 'Old' });
  const dir = g.dir('old1');
  const left = (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).sort();
  for (const f of ['.env', '.env.local', 'sub/.env', 'sub/tls.key', 'server.pem', 'credentials.json', 'app.js.map']) assert.ok(!left.includes(f), `${f} was kept`);
  assert.equal(out.files, 5, left.join(' '));
  const url = g.at('old1');
  const b = browser();
  assert.equal((await b.go(url)).text, 'hello');
  assert.equal((await b.go(`${url}.well-known/assetlinks.json`)).status, 200);
  // A version from before this fix is still on the disk: serve says no all the same.
  write(dir, { '.env': 'leak', 'sub/.env': 'leak', 'app.js.map': 'leak', 'tls.key': 'leak', 'credentials.json': 'leak', '.git/config': 'leak', '.hidden/index.html': 'leak' });
  for (const p of ['.env', 'sub/.env', '.ENV', '%2eenv', 'sub%2F.env', 'x/..%2f.env', '.htaccess', '.config/a.json', '.git/config', '.hidden/', 'app.js.map', 'tls.key', 'credentials.json']) {
    const got = await b.go(`${url}${p}`);
    assert.notEqual(got.text, 'leak', p);
    assert.equal(got.status, 404, p);
  }
  assert.equal((await b.go(`${url}app.js`)).status, 200);
  // An entry nobody may open is no entry.
  await assert.rejects(g.sites.publish(user, 'old2', (await packDir(src)).body, { title: 'Hid', entry: '.config/a.json' }), /No \.config\/a\.json in the app/);
  assert.equal(fs.readdirSync(path.join(g.dataDir, 'sites')).filter((f) => f.includes('.new-')).length, 0);
});

test('a published app with data: its own database, kept across updates, gone when unpublished', async () => {
  const g = await boot();
  const src = write(tmp('site-db'), { 'index.html': '<p>guestbook</p>', 'wisp-app.json': JSON.stringify({ name: 'Guestbook', db: true }), 'seed.sql': "CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('hello');" });
  await g.sites.publish(user, 'gb', (await packDir(src)).body, { title: 'Guestbook' });
  const url = g.at('gb');
  const b = browser();
  const q = (sql: string, params: unknown[] = []) => b.go(`${url}_wisp/db`, { method: 'POST', body: { sql, params } });
  assert.match((await b.go(`${url}_wisp/db.js`)).text, /export async function sql/);
  assert.deepEqual((await q('SELECT text FROM notes')).json, { rows: [{ text: 'hello' }] });
  assert.equal((await q('INSERT INTO notes VALUES (?)', ['from a visitor'])).status, 200);
  assert.equal((await q("ATTACH DATABASE 'x.db' AS x")).status, 400);
  assert.equal((await b.go(`${url}_wisp/db`, { method: 'POST', body: { sql: 'SELECT 1' }, headers: { origin: 'https://evil.example' } })).status, 403);
  write(src, { 'index.html': '<p>guestbook v2</p>' });
  await g.sites.publish(user, 'gb', (await packDir(src)).body, { title: 'Guestbook' });
  assert.deepEqual((await q('SELECT count(*) AS n FROM notes')).json, { rows: [{ n: 2 }] });
  const id = g.db.get<{ id: string }>('SELECT id FROM sites WHERE key = ?', 'gb')?.id ?? '';
  const file = path.join(g.dataDir, 'sites', `${id}.sqlite`);
  assert.ok(fs.existsSync(file));
  assert.equal(await g.sites.remove(user.id, 'gb'), true);
  await until(() => !fs.existsSync(file), { what: 'its data removed' });
  assert.equal(await g.sites.remove(user.id, 'gb'), false);
  // An app without "db" has no database to ask.
  const plain = write(tmp('site-nodb'), { 'index.html': 'x' });
  await g.sites.publish(user, 'nodb', (await packDir(plain)).body);
  assert.equal((await b.go(`${g.at('nodb')}_wisp/db`, { method: 'POST', body: { sql: 'SELECT 1' } })).status, 404);
});

test('an update swaps its folder in even while Windows still holds a file a visitor just read', async (t) => {
  const g = await boot();
  const src = write(tmp('sites-busy-src'), { 'index.html': 'v1' });
  await g.sites.publish(user, 'k1', (await packDir(src)).body, { title: 'Busy' });
  write(src, { 'index.html': 'v2' });
  const real = fs.promises.rename;
  let refused = 0;
  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    if (refused < 2) {
      refused++;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return real(from, to);
  });
  await g.sites.publish(user, 'k1', (await packDir(src)).body, { title: 'Busy' });
  t.mock.restoreAll();
  assert.equal(refused, 2);
  assert.equal(fs.readFileSync(path.join(g.dir('k1'), 'index.html'), 'utf8'), 'v2');
  await until(() => fs.readdirSync(path.join(g.dataDir, 'sites')).length === 1, { what: 'only the new version left' });
});

test('limits: perUser, switched off, and a body over maxBytes is a 413 that still reads to the end', async () => {
  const g = await boot({ sites: { perUser: 1 } });
  const src = write(tmp('site-cap'), { 'index.html': 'x' });
  await g.sites.publish(user, 'a', (await packDir(src)).body);
  await assert.rejects(g.sites.publish(user, 'b', (await packDir(src)).body), (e: Error & { status?: number }) => e.status === 409);
  await g.sites.publish(user, 'a', (await packDir(src)).body); // an update isn't one more
  const off = await boot({ sites: { enabled: false } });
  await assert.rejects(off.sites.publish(user, 'a', (await packDir(src)).body), (e: Error & { status?: number }) => e.status === 403);
  const srv = http.createServer((req, res) => {
    readRaw(req, 10).then(
      (b) => res.end(String(b.length)),
      (e: Error & { status?: number }) => res.writeHead(e.status ?? 500).end(e.message),
    );
  });
  const base = await listen(srv);
  const b = browser();
  assert.equal((await b.go(base, { method: 'PUT', body: 'x'.repeat(5) })).text, '7');
  const big = await b.go(base, { method: 'PUT', body: 'x'.repeat(100) });
  assert.equal(big.status, 413);
  srv.close();
  await g.sites.removeAll(user.id);
  assert.equal(g.sites.list(user.id).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(g.dataDir, 'sites')), []);
});
