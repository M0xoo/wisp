// shared/bundle.ts: the format wisp packs a folder in, and what the grid keeps out of it (v1
// test/publish-secrets.test.js, the grid's half).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundlePath, packDir, privateFile, publicFile, unpackTo } from '../src/shared/bundle.ts';
import { entry, write } from './bundle-helpers.ts';
import { tmp } from './helpers.ts';

const LEAKS = ['.env', '.env.local', '.ENV.production', 'sub/.env', '.env.example', 'credentials.json', 'credentials', 'client_secret_1234.json', 'service-account.json', '.npmrc', '.netrc', 'server.pem', 'api.key', 'deep/er/tls.KEY', 'store.p12', 'id_rsa', 'id_ed25519', 'app.js.map', 'css/site.css.map', '.git-credentials', '.env.d/prod.txt'];
const KEPT = ['index.html', 'js/app.js', 'keys.js', 'map.html', 'environment.js', 'id_rsa.pub', 'public.key.txt', 'credentials-help.html', 'wisp-app.json'];

test('the shared list: secrets and source maps are private, a public app’s files aren’t', () => {
  for (const f of LEAKS) assert.equal(privateFile(f), true, f);
  for (const f of KEPT) assert.equal(privateFile(f), false, f);
});

test('what a published app serves: no dotfile, nothing private, .well-known stays', () => {
  for (const f of ['.env', '.htaccess', 'a/.secret', '.git/config', '.config/x.json', 'a/.well-known/x', ...LEAKS]) assert.equal(publicFile(f), false, f);
  for (const f of ['.well-known/assetlinks.json', '.well-known/acme-challenge/abc', ...KEPT]) assert.equal(publicFile(f), true, f);
  assert.equal(publicFile('.well-known/.env'), false);
  assert.equal(publicFile('.well-known/tls.key'), false);
  assert.equal(publicFile('sub\\.env'), false, 'a Windows path');
});

test('packDir packs everything unless told what to skip (a shared task’s files are not an app)', async () => {
  const dir = write(tmp('pack-all'), { 'index.html': 'x', '.env': 'A=1' });
  assert.equal((await packDir(dir)).files, 2);
  const { files, list } = await packDir(dir, { skip: privateFile });
  assert.equal(files, 1);
  assert.deepEqual(list.map((f) => f.path), ['index.html']);
});

test('packDir over maxBytes is too big, not a partial bundle', async () => {
  const dir = write(tmp('pack-big'), { 'a.txt': 'x'.repeat(100) });
  await assert.rejects(packDir(dir, { maxBytes: 10 }), (err: Error & { tooBig?: boolean }) => err.tooBig === true);
});

test('unpackTo drops what skip names, and counts only what it kept; a round trip keeps every byte', async () => {
  const src = write(tmp('unpack-src'), { 'index.html': 'hello', '.env': 'A=1', 'sub/tls.key': 'k', 'sub/app.js': 'js' });
  const to = path.join(tmp('unpack-to'), 'x');
  const got = await unpackTo((await packDir(src)).body, to, { skip: privateFile });
  assert.deepEqual(got, { files: 2, size: 7 });
  assert.equal(fs.existsSync(path.join(to, '.env')), false);
  assert.equal(fs.existsSync(path.join(to, 'sub', 'tls.key')), false);
  assert.equal(fs.readFileSync(path.join(to, 'sub', 'app.js'), 'utf8'), 'js');
  assert.equal(bundlePath('.env'), '.env', 'a share’s bundle still reads whatever it holds');
  const all = path.join(tmp('unpack-all'), 'y');
  await unpackTo((await packDir(src)).body, all);
  assert.equal(fs.readFileSync(path.join(all, '.env'), 'utf8'), 'A=1');
});

test('bundlePath: nothing lands outside the folder', () => {
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a//b', './a', 'a/.', '', 'a\x00b', 'x'.repeat(401), 42]) assert.equal(bundlePath(p), null, String(p));
  assert.equal(bundlePath('a/b/c.html'), 'a/b/c.html');
});

test('unpackTo refuses a broken bundle: a path outside, a cut header, a short body, a name twice', async () => {
  const dir = () => path.join(tmp('unpack-bad'), 'x');
  await assert.rejects(unpackTo(entry({ path: '../x.html', size: 0 }), dir()), /bad file/);
  await assert.rejects(unpackTo(Buffer.from([0, 0, 0]), dir()), /ends early/);
  await assert.rejects(unpackTo(Buffer.concat([Buffer.from([0, 0, 0, 30]), Buffer.from('{"path":')]), dir()), /header in the bundle is broken/);
  await assert.rejects(unpackTo(entry({ path: 'a.txt', size: 10 }, 'abc'), dir()), /bad file/);
  await assert.rejects(unpackTo(Buffer.concat([entry({ path: 'a.txt', size: 1 }, 'a'), entry({ path: 'a.txt', size: 1 }, 'b')]), dir()), /EEXIST/);
});
