import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { whatsNew, publish, NOTES_MAX, PACKAGE } from '../scripts/play.mjs';

const CHANGELOG = `# Changelog\r
\r
## [Unreleased]\r
\r
- **Swipe a task in the phone app's list.** Swipe right.\r
- **Desktop only thing.** Nothing about it.\r
\r
## [1.2.0] - 2026-10-28\r
\r
- **Notifications on Android.** Stays connected.\r
\r
## [1.1.0] - 2026-10-27\r
\r
- **Older phone fix.** Too old to list.\r
`;

test('whatsNew lists the phone headlines of Unreleased and the last release', () => {
  assert.equal(whatsNew(CHANGELOG), "- Swipe a task in the phone app's list\n- Notifications on Android");
});

test('whatsNew prefers mobile/whatsnew.txt and keeps to Play\'s 500 chars in whole lines', () => {
  assert.equal(whatsNew(CHANGELOG, '  Hand-written notes\r\n'), 'Hand-written notes');
  const long = Array.from({ length: 40 }, (_, i) => `- line number ${i} with some words`).join('\n');
  const out = whatsNew(CHANGELOG, long);
  assert.ok(out.length <= NOTES_MAX);
  assert.ok(out.endsWith('words'));
  assert.equal(whatsNew('# nothing\n'), 'Fixes and improvements.');
});

// A fake Google: the token endpoint checks the JWT's signature, the Play API records each call.
async function fakeGoogle(t, { refuse } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  let edits = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/token') {
        const [h, p, s] = new URLSearchParams(body.toString()).get('assertion').split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
        return ok ? send(200, { access_token: 'tok' }) : send(401, { error: 'invalid_grant' });
      }
      assert.equal(req.headers.authorization, 'Bearer tok');
      const url = req.url.split('?')[0].replace(`/applications/${PACKAGE}`, '');
      calls.push(`${req.method} ${url}`);
      if (url.endsWith('/edits')) return send(200, { id: `e${++edits}` });
      if (url.endsWith('/bundles')) return send(200, { versionCode: 120, size: body.length });
      if (url.includes('/tracks/')) {
        if (refuse && url.endsWith(refuse)) return send(403, { error: { message: 'Production is locked' } });
        calls.push(JSON.parse(body).releases[0]);
        return send(200, {});
      }
      if (url.endsWith(':commit')) return send(200, {});
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const aab = path.join(dir, 'app.aab');
  fs.writeFileSync(aab, 'bundle');
  const key = { client_email: 'ci@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token` };
  return { calls, aab, key, api: base };
}

test('publish uploads to internal testing, then promotes the same build in its own edit', async (t) => {
  const g = await fakeGoogle(t);
  const log = [];
  await publish({ ...g, versionCode: 120, versionName: '0.2.0', notes: 'n', promote: 'production', log: (l) => log.push(l) });
  const v = '/androidpublisher/v3/edits';
  assert.deepEqual(g.calls.filter((c) => typeof c === 'string'), [
    `POST ${v}`, `POST /upload${v}/e1/bundles`, `PUT ${v}/e1/tracks/internal`, `POST ${v}/e1:commit`,
    `POST ${v}`, `PUT ${v}/e2/tracks/production`, `POST ${v}/e2:commit`,
  ]);
  assert.deepEqual(g.calls.find((c) => typeof c === 'object'), {
    name: '120 (0.2.0)', versionCodes: ['120'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'n' }],
  });
  assert.deepEqual(log, ['Internal testing: 120 (0.2.0)', 'production: 120 (0.2.0)']);
});

test('a refused promotion fails with Play\'s message after internal testing is committed', async (t) => {
  const g = await fakeGoogle(t, { refuse: '/tracks/production' });
  await assert.rejects(
    publish({ ...g, versionCode: 120, versionName: '0.2.0', notes: 'n', promote: 'production', log: () => {} }),
    /Play PUT .*tracks\/production failed \(403\): Production is locked/,
  );
  assert.ok(g.calls.includes('POST /androidpublisher/v3/edits/e1:commit'));
});

test('publish refuses a bundle whose versionCode is not the one built', async (t) => {
  const g = await fakeGoogle(t);
  await assert.rejects(publish({ ...g, versionCode: 121, versionName: '0.2.0', notes: 'n', log: () => {} }), /versionCode 120, expected 121/);
  assert.ok(!g.calls.some((c) => typeof c === 'string' && c.endsWith(':commit')));
});

test('a bad key fails at sign-in', async (t) => {
  const g = await fakeGoogle(t);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(publish({ ...g, key: { ...g.key, private_key: other }, versionCode: 120, versionName: '0.2.0', notes: 'n' }), /Google sign-in failed \(401\): invalid_grant/);
});
