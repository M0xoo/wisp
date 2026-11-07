// The node:http adapter end to end on loopback: a real SSE stream read by SseParser into a
// SyncClient, messages and commands by POST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CommandResponse } from '@wisp/protocol';
import { NodeSync, command } from '../src/node-sse.ts';
import { SseParser, decodeFrame } from '../src/sse.ts';
import { SyncClient } from '../src/client.ts';
import type { ClientOutput } from '../src/types.ts';
import { FakeStore, makeServer } from './harness.ts';

/** A wisp with one list row, a fake `session.rename`, and its routes on loopback. */
async function serve(): Promise<{ store: FakeStore; sync: ReturnType<typeof makeServer>; host: NodeSync<string>; base: string; stop: () => Promise<void> }> {
  const store = new FakeStore();
  store.commit([{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'one' } }]);
  const sync = makeServer(store, { heartbeatMs: 60_000 });
  const ran = new Map<string, CommandResponse>(); // the mutation table: one run per key
  const run = (cmd: string, args: unknown, mid: string): CommandResponse => {
    const done = ran.get(mid);
    if (done !== undefined) return done;
    if (cmd !== 'session.rename') return { ok: false, error: { code: 'not_found', message: cmd } };
    const rows = store.commit([{ topic: 'list', e: 'session', id: 's1', op: 'set', v: { title: String((args as { title: string }).title) } }]);
    host.input({ kind: 'committed', rows });
    const out: CommandResponse = { ok: true, seq: store.seq };
    ran.set(mid, out);
    return out;
  };
  const host: NodeSync<string> = new NodeSync<string>({
    sync,
    onOutput(o) {
      if (o.kind === 'snapshotRequest') host.input({ kind: 'snapshotRows', conn: o.conn, topic: o.topic, req: o.req, seq: store.seq, rows: store.snapshot(o.topic), full: true });
      if (o.kind === 'command') {
        const r = run(o.cmd, o.args, o.mid);
        host.input({ kind: 'commandResult', conn: o.conn, mid: o.mid, outcome: r.ok ? { ok: true, seq: r.seq } : { ok: false, ...r.error } });
      }
    },
    sameCaller: (a, b) => a === b,
  });
  const http = createServer((req, res) => {
    const caller = String(req.headers['x-test-caller'] ?? 'me');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && path === '/api/events') return host.events(req, res, caller);
    if (req.method === 'POST' && path === '/api/events') return void host.message(req, res, caller);
    if (req.method === 'POST' && path === '/api/cmd') return void command(req, res, caller, async (cmd, args, call) => run(cmd, args, call.mid));
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const stop = async (): Promise<void> => {
    host.close();
    await new Promise<void>((ok) => http.close(() => ok()));
  };
  return { store, sync, host, base, stop };
}

test('a stream, a mutate over it, and the HTTP fallback of a command', async () => {
  const { store, sync, base, stop } = await serve();
  try {
    const client = new SyncClient({ peer: 'laptop', clientId: 'tab1', build: 't' });
    client.handle({ kind: 'subscribe', topic: 'list' }, 0);
    const req = client.handle({ kind: 'open' }, 0).find((o) => o.kind === 'request');
    assert.ok(req?.kind === 'request');
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events?${new URLSearchParams(req.params)}`, { signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const parser = new SseParser();
    const outs: ClientOutput[] = [];
    const until = async (ok: () => boolean): Promise<void> => {
      while (!ok()) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        for (const ev of parser.push(value)) {
          const f = decodeFrame(ev);
          if (f === null) continue;
          outs.push(...client.handle({ kind: 'frame', id: f.id, messages: f.messages }, Date.now()));
        }
      }
    };
    await until(() => outs.some((o) => o.kind === 'snapshot'));
    assert.equal(client.state, 'live');
    assert.equal(parser.retry, 2000);

    // a mutate rides a POST to the stream; its ack and patch come back on it
    const post = (body: unknown, caller = 'me') => fetch(`${base}/api/events`, { method: 'POST', headers: { 'x-wisp-client': 'tab1', 'x-test-caller': caller }, body: JSON.stringify(body) });
    const m = client.handle({ kind: 'mutate', mid: 'm1', cmd: 'session.rename', args: { title: 'two' } }, 0).find((o) => o.kind === 'send');
    assert.equal((await post(m?.kind === 'send' ? m.message : null)).status, 202);
    await until(() => outs.some((o) => o.kind === 'ack'));
    const ops = outs.filter((o) => o.kind === 'entityOps').flatMap((o) => (o.kind === 'entityOps' ? o.ops : []));
    assert.deepEqual(ops.map((o) => o.op === 'patch' && o.ops), [[{ op: 'replace', path: '/title', value: 'two' }]]);
    assert.ok(outs.findIndex((o) => o.kind === 'ack') > outs.findIndex((o) => o.kind === 'entityOps'));
    assert.equal(client.cursor, store.seq);
    assert.equal((await post({ t: 'unsub', topic: 'list' }, 'someone-else')).status, 403, 'a POST drives only its own stream');

    // the HTTP fallback: an Idempotency-Key is required, and a retry never runs twice
    const cmd = (key: string | null, body: unknown) => fetch(`${base}/api/cmd`, { method: 'POST', headers: key === null ? {} : { 'idempotency-key': key }, body: JSON.stringify(body) });
    assert.equal((await cmd(null, { cmd: 'session.rename', args: { title: 'x' } })).status, 400);
    const a = await (await cmd('k1', { cmd: 'session.rename', args: { title: 'three' } })).json();
    const b = await (await cmd('k1', { cmd: 'session.rename', args: { title: 'four' } })).json();
    assert.deepEqual(a, b);
    assert.equal(store.rows.get('list')?.get('session\u0000s1')?.v && (store.rows.get('list')?.get('session\u0000s1')?.v as { title: string }).title, 'three');
    assert.equal((await cmd('k2', { cmd: 'nope', args: null })).status, 404);
    assert.equal((await cmd('k3', 'not an object')).status, 400);

    ac.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && sync.connOf('tab1') !== undefined; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sync.connOf('tab1'), undefined, 'a closed socket closes the connection');
  } finally {
    await stop();
  }
});
