// What a published app must not hand to the world. Publish is a public link: .env files, credentials
// and source maps stay home, the grid keeps them out for clients too old to, and a key inside an
// app's own files stops the publish. Public keys and placeholders in a working app don't.
// The grid's own side is in test/grid.test.js (it needs node:sqlite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bundlePath, packDir, privateFile, publicFile, unpackTo } from '../server/bundle.js';
import { Stuff } from '../server/services/stuff.js';
import { createPublish } from '../server/services/publish.js';
import { scanApp } from '../server/app-scan.js';
import { tmp } from './helpers.js';

// Built at run time, so this file never trips a repo's own secret scan.
const FAKE = {
  aws: `AKIA${'Q7ZK3M9TLB2XW4NP'}`,
  stripe: `sk_live_${'9aZ3kQ7mX2pL5vB8nR4tY1cW'}`,
  github: `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
  anthropic: `sk-ant-api03-${'Zx9Qw3Er7Ty1Ui5Op2As6Df0'}`,
  google: `AIza${'Sy9kX2mQ7vB4nR8tL1pZ5cW3jH6gF0dS4aE'}`,
};
const jwt = (payload) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(payload)}.${'k3Jd9sLq2Xv7Zp1Rt5Yw8Mn4Bc6Gf0Ha'}`;
};
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};
const LEAKS = ['.env', '.env.local', '.ENV.production', 'sub/.env', '.env.example', 'credentials.json', 'credentials', 'client_secret_1234.json', 'service-account.json', '.npmrc', '.netrc', 'server.pem', 'api.key', 'deep/er/tls.KEY', 'store.p12', 'id_rsa', 'id_ed25519', 'app.js.map', 'css/site.css.map', '.git-credentials', '.env.d/prod.txt'];
const KEPT = ['index.html', 'js/app.js', 'keys.js', 'map.html', 'environment.js', 'id_rsa.pub', 'public.key.txt', 'credentials-help.html', 'wisp-app.json'];

test('the shared list: secrets and source maps are private, a public app’s files aren’t', () => {
  for (const f of LEAKS) assert.equal(privateFile(f), true, f);
  for (const f of KEPT) assert.equal(privateFile(f), false, f);
});

test('what a published app serves: no dotfile, nothing private, .well-known stays', () => {
  for (const f of ['.env', '.htaccess', 'a/.secret', '.git/config', '.config/x.json', 'a/.well-known/x', ...LEAKS]) assert.equal(publicFile(f), false, f);
  for (const f of ['.well-known/assetlinks.json', '.well-known/acme-challenge/abc', ...KEPT.filter((x) => x !== 'x')]) assert.equal(publicFile(f), true, f);
  assert.equal(publicFile('.well-known/.env'), false);
  assert.equal(publicFile('.well-known/tls.key'), false);
  assert.equal(publicFile('sub\\.env'), false, 'a Windows path');
});

test('packDir packs everything unless told what to skip (a shared task’s files are not an app)', () => {
  const dir = write(tmp('pack-all'), { 'index.html': 'x', '.env': 'A=1' });
  assert.equal(packDir(dir).files, 2);
  const { files, list } = packDir(dir, { skip: privateFile });
  assert.equal(files, 1);
  assert.deepEqual(list.map((f) => f.path), ['index.html']);
});

test('unpackTo drops what skip names, and counts only what it kept', () => {
  const src = write(tmp('unpack-src'), { 'index.html': 'hello', '.env': 'A=1', 'sub/tls.key': 'k', 'sub/app.js': 'js' });
  const to = path.join(tmp('unpack-to'), 'x');
  const got = unpackTo(packDir(src).body, to, { skip: privateFile });
  assert.deepEqual(got, { files: 2, size: 7 });
  assert.equal(fs.existsSync(path.join(to, '.env')), false);
  assert.equal(fs.existsSync(path.join(to, 'sub', 'tls.key')), false);
  assert.equal(fs.readFileSync(path.join(to, 'sub', 'app.js'), 'utf8'), 'js');
  assert.equal(bundlePath('.env'), '.env', 'a share’s bundle still reads whatever it holds');
});

test('Save to My Stuff leaves secrets out of an app’s copy, on the same list', () => {
  const src = write(tmp('save-src'), { 'index.html': 'x', 'js/app.js': 'y', ...Object.fromEntries(LEAKS.map((f) => [f, 'nope'])) });
  const stuff = new Stuff(tmp('save-stuff'));
  const it = stuff.addApp(src, {});
  assert.equal(it.files, 2);
  for (const f of LEAKS) assert.equal(fs.existsSync(path.join(it.path, f)), false, f);
  assert.equal(fs.existsSync(path.join(it.path, 'js', 'app.js')), true);
});

// wisp on a laptop publishing to something that records what it was sent.
async function publisher(files) {
  const got = [];
  const grid = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://demo--app--pia.grid.test/' }));
    });
  });
  await new Promise((r) => grid.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${grid.address().port}`;
  const stuff = new Stuff(tmp('pub-stuff'));
  const it = stuff.addApp(write(tmp('pub-src'), files), { title: 'Demo' });
  const pub = createPublish({ stuff, machines: { list: [{ id: 'm1', kind: 'grid', grid: base, handle: 'pia' }] }, secrets: { get: () => 'tok' } }, { env: {} });
  return { it, stuff, pub, got, close: () => grid.close() };
}

test('publish refuses a key in the app’s files: says file and line, never the key, and nothing goes up', async () => {
  const p = await publisher({ 'index.html': '<script src=config.js></script>', 'js/config.js': `// config\nconst base = '/api';\nconst key = '${FAKE.aws}';\n` });
  try {
    await assert.rejects(p.pub.publish(p.it.id), (e) => {
      assert.equal(e.status, 422);
      assert.match(e.message, /js\/config\.js/);
      assert.match(e.message, /line 3/);
      assert.match(e.message, /AWS access key/);
      assert.ok(!e.message.includes(FAKE.aws));
      return true;
    });
    assert.equal(p.got.length, 0);
    assert.ok(!p.stuff.get(p.it.id).published);
  } finally {
    p.close();
  }
});

test('an app saved before this kept its .env: publish still leaves it out', async () => {
  const p = await publisher({ 'index.html': 'ok' });
  try {
    write(p.it.path, { '.env': `AWS=${FAKE.aws}`, 'app.js.map': '{}', 'js/a.js': '1' });
    await p.pub.publish(p.it.id);
    const sent = p.got[0].toString('latin1');
    assert.ok(!sent.includes('.env') && !sent.includes(FAKE.aws) && !sent.includes('.map'));
    assert.match(sent, /js\/a\.js/);
  } finally {
    p.close();
  }
});

test('a clean app goes up, and its result carries the link', async () => {
  const p = await publisher({ 'index.html': '<h1>hi</h1>', 'js/app.js': 'console.log(1)' });
  try {
    const out = await p.pub.publish(p.it.id);
    assert.equal(out.published.url, 'https://demo--app--pia.grid.test/');
    assert.equal(p.got.length, 1);
  } finally {
    p.close();
  }
});

const hits = (files) => scanApp(Object.entries(files).map(([rel, text]) => ({ path: rel, data: Buffer.from(text) })));
const KEEP = {
  'Firebase web config, as Google documents it': { 'a.js': `const firebaseConfig = {\n  apiKey: "${FAKE.google}",\n  authDomain: "demo.firebaseapp.com",\n  projectId: "demo",\n};` },
  'Firebase, minified': { 'a.js': `var c={apiKey:"${FAKE.google}",authDomain:"demo.firebaseapp.com"};` },
  'Maps script tag': { 'index.html': `<script src="https://maps.googleapis.com/maps/api/js?key=${FAKE.google}&callback=init"></script>` },
  'Stripe publishable key': { 'a.js': `const stripe = Stripe('pk_live_${'51Hx9aZ3kQ7mX2pL5vB8nR4tY1cW'}');\nconst pk = { api_key: "pk_test_${'51Hx9aZ3kQ7mX2pL5vB8nR4tY1cW'}" };` },
  'Mapbox public token': { 'a.js': `mapboxgl.accessToken = 'pk.eyJ1Ijoid2lzcCIsImEiOiJjbHgxMjM0NTYifQ.${'Ab3dEf7hIj1lMn5pQr9tUv'}';` },
  'PostHog project key': { 'a.js': `posthog.init('phc_${'Ab3dEf7hIj1lMn5pQr9tUvWx2z'}', { api_host: 'https://us.i.posthog.com' });\nconst cfg = { api_key: 'phc_${'Ab3dEf7hIj1lMn5pQr9tUvWx2z'}' };` },
  'Supabase anon key': { 'a.js': `const c = createClient(url, '${jwt({ iss: 'supabase', ref: 'abc', role: 'anon' })}');` },
  'NEXT_PUBLIC name': { 'a.js': `const NEXT_PUBLIC_API_KEY = "${'9f8e7d6c5b4a39281706f5e4d3c2b1a0'}";` },
  'a public key block': { 'a.js': `const pem = "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\\n-----END PUBLIC KEY-----";` },
  'code that reads a value': { 'a.js': `const token = response.data.accessToken;\nlet password = document.getElementById;\nconst apiKey = process.env.PUBLIC_MAP_KEY_VALUE;\nsecret=crypto.randomBytes;` },
  'a library that parses PEM': { 'a.js': `var t="-----BEGIN PRIVATE KEY-----";function p(s){return s.replace(t,"")}` },
  'design tokens and strings': { 'a.json': `{ "token": "color.background.primary.hover", "password": "auth.password.placeholder.text" }` },
  'placeholders': {
    'a.js': [`apiKey: "your-api-key-goes-here-please"`, `api_key = "<YOUR_API_KEY_GOES_HERE>"`, `token: "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"`, `const k = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`, `const g = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`, `const s = "sk_live_${'x'.repeat(24)}";`, `const a = "AKIAIOSFODNN7EXAMPLE";`, `const o = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";`].join('\n'),
    'readme.md': ['Set `DATABASE_URL=postgres://user:password@localhost:5432/app`', 'or mysql://root:changeme@127.0.0.1/db', 'https://user:pass@example.com/', 'postgres://me:<password>@db.example.org/app', 'postgres://me:${DB_PASS}@prod.internal/app'].join('\n'),
  },
  'the jwt.io sample': { 'docs.html': `<code>eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c</code>` },
  'an image with no text': { 'a.png': `\0\0\0${FAKE.aws}` },
};
for (const [name, files] of Object.entries(KEEP)) test(`publish scan lets through: ${name}`, () => assert.deepEqual(hits(files), []));

const REFUSE = {
  'an AWS key': [`const k = "${FAKE.aws}";`, 'an AWS access key'],
  'a Stripe secret key': [`stripe = "${FAKE.stripe}"`, 'a Stripe key'],
  'a GitHub token': [`fetch(u, { headers: { authorization: 'token ${FAKE.github}' } })`, 'a GitHub token'],
  'an Anthropic key': [`const client = new Anthropic({ apiKey: "${FAKE.anthropic}" });`, 'an Anthropic API key'],
  'a Google key with no Firebase or Maps around it': [`fetch("https://generativelanguage.googleapis.com/v1/models?key=${FAKE.google}")`, 'a Google API key'],
  'a service role JWT': [`createClient(url, '${jwt({ iss: 'supabase', role: 'service_role' })}')`, 'a JSON Web Token'],
  'a real private key, PEM lines': [`-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----`, 'a private key'],
  'a real private key in a string': [`const k = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\\n";`, 'a private key'],
  'a password in a real URL': [`const db = "postgres://admin:h7Kq2mZx@prod-db.acme.io:5432/app";`, 'a password in a URL'],
  'a quoted secret value': [`const cfg = { api_key: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" };`, 'a secret value'],
  'a secret value in a data file': [`client_secret: 9f8e7d6c5b4a39281706f5e4d3c2b1a0`, 'a secret value', 'config.yaml'],
  'a real key after a placeholder on one minified line': [`var a="sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",b="${FAKE.anthropic}";`, 'an Anthropic API key'],
};
for (const [name, [text, what, file = 'a.js']] of Object.entries(REFUSE))
  test(`publish scan refuses: ${name}`, () => {
    const h = hits({ [file]: text });
    assert.equal(h.length >= 1, true, 'no hit');
    assert.equal(h[0].what, what);
    assert.equal(h[0].where, file);
    assert.ok(!JSON.stringify(h).includes(text.slice(10, 30)));
  });

test('a seed database is scanned though it’s binary', () => {
  assert.equal(hits({ 'seed.sqlite': `SQLite format 3\0\0\0${FAKE.aws}\0` })[0].what, 'an AWS access key');
});

test('what an agent is told about a published app’s data', async () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/['"]\s*\+\s*['"]/g, '');
  const line = /anyone with the link can read and change (this app's|that|its) data, so no personal data/i;
  for (const f of ['server/routes/internal.js', 'server/mcp-ask.js', 'server/pane-guide.js']) assert.match(read(f), line, f);
  assert.match(read('web/js/features/stuff.js'), /Anyone with the link can read and change this app’s data, so no personal data in it\./);
});
