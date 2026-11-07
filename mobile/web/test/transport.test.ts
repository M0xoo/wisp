import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerDown, type Frame } from '@wisp/client';
import { bridgeTransport, gridAsleep } from '../src/transport.ts';
import { fakeBridge, fakeServer, welcome } from './helpers.ts';

const params = { client_id: 'c1', proto_min: '2', proto_max: '2' };

/** opens one connection and reads its first frame */
async function first(iter: AsyncIterable<Frame>): Promise<Frame | undefined> {
  for await (const f of iter) return f;
  return undefined;
}

test('each connect asks the bridge again: a tunnel back on a new port is followed', async () => {
  const bridge = fakeBridge();
  bridge.answers = [
    { kind: 'ssh', port: 5001, token: 'wlt_1', name: 'Studio' },
    { kind: 'ssh', port: 5002, token: 'wlt_1', name: 'Studio' },
  ];
  const srv = fakeServer();
  const t = bridgeTransport(bridge, { id: 'studio', kind: 'ssh' }, { fetch: srv.fetch });
  assert.equal(t.kind, 'ssh');
  assert.equal(t.wake, undefined, 'an SSH computer has nothing to wake');
  for (const port of [5001, 5002]) {
    const ctl = new AbortController();
    const frame = first(t.connect(params, ctl.signal));
    await new Promise((r) => setImmediate(r));
    srv.streams.at(-1)?.frame(null, welcome());
    assert.equal((await frame)?.messages[0]?.t, 'welcome');
    assert.match(srv.requests.at(-1)?.url ?? '', new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/events\\?`));
    ctl.abort();
  }
  assert.deepEqual(bridge.connects, ['studio', 'studio']);
});

test('the token goes as a Bearer header on the stream and on every post, with the stream’s client id', async () => {
  const bridge = fakeBridge();
  bridge.answers = [{ kind: 'ssh', port: 5001, token: 'wlt_secret', name: 'Studio' }];
  const srv = fakeServer();
  const t = bridgeTransport(bridge, { id: 'studio', kind: 'ssh' }, { fetch: srv.fetch });
  const ctl = new AbortController();
  const frame = first(t.connect(params, ctl.signal));
  await new Promise((r) => setImmediate(r));
  srv.streams[0]?.frame(null, welcome());
  await frame;
  await t.post({ t: 'sub', topic: 'list' }, ctl.signal);
  const [get, post] = srv.requests;
  assert.equal(get?.headers['authorization'], 'Bearer wlt_secret');
  assert.equal(get?.headers['accept'], 'text/event-stream');
  assert.equal(post?.method, 'POST');
  assert.equal(post?.url, 'http://127.0.0.1:5001/api/events');
  assert.equal(post?.headers['authorization'], 'Bearer wlt_secret');
  assert.equal(post?.headers['x-wisp-client'], 'c1');
  assert.deepEqual(JSON.parse(post?.body ?? ''), { t: 'sub', topic: 'list' });
  ctl.abort();
});

test('a wisp with no token (older, or none written yet) gets no authorization header', async () => {
  const bridge = fakeBridge();
  bridge.answers = [{ kind: 'ssh', port: 4477, token: '', name: 'Studio' }];
  const srv = fakeServer();
  const ctl = new AbortController();
  const it = bridgeTransport(bridge, { id: 'studio', kind: 'ssh' }, { fetch: srv.fetch }).connect(params, ctl.signal);
  const frame = first(it);
  await new Promise((r) => setImmediate(r));
  srv.streams[0]?.frame(null, welcome());
  await frame;
  assert.equal('authorization' in (srv.requests[0]?.headers ?? {}), false);
  ctl.abort();
});

test('a bridge that can’t reach the computer is PeerDown unreachable, with its reason; nothing is fetched', async () => {
  const bridge = fakeBridge();
  bridge.answers = [new Error('Connection refused by studio:22.')];
  const srv = fakeServer();
  const t = bridgeTransport(bridge, { id: 'studio', kind: 'ssh' }, { fetch: srv.fetch });
  await assert.rejects(first(t.connect(params, new AbortController().signal)), (err: unknown) => {
    assert.ok(err instanceof PeerDown);
    assert.equal(err.status, 'unreachable');
    assert.equal(err.message, 'Connection refused by studio:22.');
    return true;
  });
  assert.equal(srv.requests.length, 0);
  await assert.rejects(t.post({ t: 'sub', topic: 'list' }, new AbortController().signal), PeerDown, 'no stream: nowhere to post');
});

test('a grid computer: its https address with the device token; asleep only for 503 + asleep, wake asks its health', async () => {
  const bridge = fakeBridge();
  bridge.answers = [{ kind: 'grid', base: 'https://mo.grid.test', token: 'dev-1', name: 'wisp Cloud' }];
  const srv = fakeServer();
  srv.reply = (r) => (r.url.includes('/api/events?') ? { status: 503, body: '{"asleep":true}' } : undefined);
  const t = bridgeTransport(bridge, { id: 'cloud', kind: 'grid' }, { fetch: srv.fetch });
  assert.equal(t.kind, 'grid');
  await assert.rejects(first(t.connect(params, new AbortController().signal)), (err: unknown) => err instanceof PeerDown && err.status === 'asleep');
  assert.match(srv.requests[0]?.url ?? '', /^https:\/\/mo\.grid\.test\/api\/events\?/);
  assert.equal(srv.requests[0]?.headers['authorization'], 'Bearer dev-1');
  srv.reply = (r) => (r.url.includes('/api/events?') ? { status: 503, body: '{"error":"It’s still waking up.","waking":true}' } : undefined);
  await assert.rejects(first(t.connect(params, new AbortController().signal)), (err: unknown) => err instanceof PeerDown && err.status === 'unreachable');
  await t.wake?.(new AbortController().signal);
  const health = srv.requests.at(-1);
  assert.equal(health?.url, 'https://mo.grid.test/api/health');
  assert.equal(health?.headers['authorization'], 'Bearer dev-1');
  srv.reply = () => ({ status: 401, body: '{"error":"Sign in again."}' });
  await assert.rejects(t.wake?.(new AbortController().signal) ?? Promise.resolve(), /Signed out of wisp Cloud/);
});

test('gridAsleep: only a 503 that says asleep', () => {
  assert.equal(gridAsleep(503, '{"asleep":true}'), true);
  assert.equal(gridAsleep(503, '{"waking":true}'), false);
  assert.equal(gridAsleep(503, 'Service Unavailable'), false);
  assert.equal(gridAsleep(502, '{"asleep":true}'), false);
});
