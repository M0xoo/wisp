// The API's JSON answers (v1 test/respond.test.js): big ones compressed, and a big read that hasn't
// changed answered with a 304, so the phone's tunnel doesn't carry the same task twice.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { prepared, readJson, send } from '../src/http/respond.ts';
import { request } from './helpers.ts';

let server: http.Server;
let port = 0;
let body: unknown = { turns: 'x'.repeat(20_000) };
const list = prepared({ sessions: 'z'.repeat(20_000) });
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/small') send(res, 200, { ok: true });
    else if (req.url === '/missing') send(res, 404, { error: 'x'.repeat(20_000) });
    else if (req.url === '/list') send(res, 200, list);
    else send(res, 200, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

test('a big read has an ETag, and asking again with it gets a bodiless 304 until it changes', async () => {
  const a = await request(port, '/task', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(a.status, 200);
  assert.match(String(a.headers.etag), /^W\/".+"$/);
  assert.equal(a.headers['cache-control'], 'private, no-cache');
  const again = await request(port, '/task', { headers: { 'accept-encoding': 'gzip', 'if-none-match': String(a.headers.etag) } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  body = { turns: 'y'.repeat(20_000) };
  const changed = await request(port, '/task', { headers: { 'if-none-match': String(a.headers.etag) } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, a.headers.etag);
  assert.equal(String((changed.json() as { turns: string }).turns[0]), 'y');
});

test('small answers, errors and writes carry no ETag', async () => {
  assert.equal((await request(port, '/small')).headers.etag, undefined);
  assert.equal((await request(port, '/missing')).headers.etag, undefined);
  assert.equal((await request(port, '/task', { method: 'POST' })).headers.etag, undefined);
});

test('big answers go brotli to a client that takes it, gzip to one that takes only that, plain otherwise', async () => {
  const br = await request(port, '/task', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'accept-encoding');
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body).toString()), body);
  const gz = await request(port, '/task', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body).toString()), body);
  const plain = await request(port, '/task');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal((await request(port, '/small', { headers: { 'accept-encoding': 'br' } })).headers['content-encoding'], undefined, 'small ones go as they are');
});

test('a prepared answer is serialised once and keeps its ETag and compressed copies', async () => {
  const a = await request(port, '/list', { headers: { 'accept-encoding': 'br' } });
  const b = await request(port, '/list', { headers: { 'accept-encoding': 'br' } });
  assert.equal(a.headers.etag, b.headers.etag);
  assert.equal(list.etag, a.headers.etag);
  assert.ok(list.out.br, 'the brotli copy is kept on it');
  assert.deepEqual(a.body, b.body);
});

// A request body arrives in chunks cut anywhere, even inside one character's UTF-8 bytes.
const feed = (chunks: Buffer[]): Promise<unknown> => {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const out = readJson(req);
  for (const c of chunks) req.emit('data', c);
  req.emit('end');
  return out;
};

test('readJson keeps a multibyte character split across two chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ prompt: 'café 🎉' }));
  for (const ch of ['é', '🎉']) {
    const at = bytes.indexOf(Buffer.from(ch)) + 1; // inside the character
    assert.deepEqual(await feed([bytes.subarray(0, at), bytes.subarray(at)]), { prompt: 'café 🎉' });
  }
});

test('readJson counts the size limit in bytes, not characters', async () => {
  const big = Buffer.from(JSON.stringify({ s: '€'.repeat(700_000) })); // ~2.1 MB, 700k characters
  await assert.rejects(feed([big]), { status: 413 });
});

test('readJson refuses what is not JSON with a 400, and an empty body is {}', async () => {
  await assert.rejects(feed([Buffer.from('{nope')]), { status: 400 });
  assert.deepEqual(await feed([]), {});
});
