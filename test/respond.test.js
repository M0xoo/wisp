// The API's JSON answers (server/http/respond.js): big ones gzipped, and a big read that hasn't
// changed answered with a 304, so the phone's tunnel doesn't carry the same task twice.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { send } from '../server/http/respond.js';

let server;
let base;
let body = { turns: 'x'.repeat(20_000) };
before(async () => {
  server = http.createServer((req, res) => (req.url === '/small' ? send(res, 200, { ok: true }) : req.url === '/missing' ? send(res, 404, { error: 'x'.repeat(20_000) }) : send(res, 200, body)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    http
      .request(`${base}${path}`, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject)
      .end();
  });

test('a big read has an ETag, and asking again with it gets a bodiless 304 until it changes', async () => {
  const a = await get('/task', { 'accept-encoding': 'gzip' });
  assert.equal(a.status, 200);
  assert.match(a.headers.etag, /^W\/".+"$/);
  assert.equal(a.headers['cache-control'], 'private, no-cache');
  const again = await get('/task', { 'accept-encoding': 'gzip', 'if-none-match': a.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  body = { turns: 'y'.repeat(20_000) };
  const changed = await get('/task', { 'if-none-match': a.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, a.headers.etag);
  assert.equal(JSON.parse(changed.body).turns[0], 'y');
});

test('small answers, errors and writes carry no ETag', async () => {
  assert.equal((await get('/small')).headers.etag, undefined);
  assert.equal((await get('/missing')).headers.etag, undefined);
  assert.equal((await get('/task', {}, 'POST')).headers.etag, undefined);
});
