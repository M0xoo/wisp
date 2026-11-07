import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage } from '@wisp/protocol';
import { encodeFrame } from '@wisp/sync';
import { httpTransport, type FetchLike, type FetchResponse } from '../src/http.ts';
import { indexedDBPersist, type IdbFactory, type IdbKeyRangeStatic } from '../src/persist-idb.ts';
import { memoryPersist, type Persist } from '../src/persist.ts';
import { PeerDown } from '../src/transport.ts';
import { welcome } from './helpers.ts';

// ---------- a fake IndexedDB: the subset persist-idb.ts uses, async like the real one ----------

type Range = { lo: string; hi: string };
function fakeIndexedDB(): { idb: IdbFactory; range: IdbKeyRangeStatic } {
  const data = new Map<string, unknown>();
  let created = false;
  const later = (fn: () => void): void => void Promise.resolve().then(fn);
  const req = <T>(get: () => T) => {
    const r: { result: T | undefined; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      r.result = get();
      r.onsuccess?.();
    });
    return r;
  };
  const inRange = (k: string, range: unknown): boolean => k >= (range as Range).lo && k <= (range as Range).hi;
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => (created = true),
    transaction: () => {
      const tx = { error: null, oncomplete: null as (() => void) | null, onerror: null, onabort: null, objectStore: () => store };
      setImmediate(() => tx.oncomplete?.());
      const store = {
        get: (k: string) => req(() => structuredClone(data.get(k))),
        put: (v: unknown, k: string) => data.set(k, structuredClone(v)),
        delete: (k: string) => data.delete(k),
        getAll: (range: unknown) => req(() => [...data.keys()].sort().filter((k) => inRange(k, range)).map((k) => data.get(k))),
        getAllKeys: (range: unknown) => req(() => [...data.keys()].sort().filter((k) => inRange(k, range))),
      };
      return tx;
    },
  };
  const idb = {
    open: () => {
      const r = { result: db, error: null, onsuccess: null as (() => void) | null, onerror: null, onupgradeneeded: null as (() => void) | null };
      later(() => {
        if (!created) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { idb: idb as unknown as IdbFactory, range: { bound: (lo, hi) => ({ lo, hi }) } };
}

async function persistContract(name: string, p: Persist): Promise<void> {
  await p.write([
    { ns: 'rows:laptop', key: 'session\u0000laptop:s1', value: { v: 1 } },
    { ns: 'rows:laptop', key: 'session\u0000laptop:s2', value: { v: 2 } },
    { ns: 'rows:box', key: 'k', value: [1, 2] },
    { ns: 'link', key: 'laptop', value: { cursor: 9 } },
  ]);
  assert.deepEqual(await p.get('link', 'laptop'), { cursor: 9 }, name);
  assert.equal((await p.entries('rows:laptop')).length, 2, name);
  assert.deepEqual((await p.namespaces('rows:')).sort(), ['rows:box', 'rows:laptop'], name);
  await p.write([{ ns: 'rows:laptop', key: 'session\u0000laptop:s1', value: undefined }]);
  assert.deepEqual(await p.entries('rows:laptop'), [['session\u0000laptop:s2', { v: 2 }]], name);
  await p.clear('rows:laptop');
  assert.deepEqual(await p.entries('rows:laptop'), [], name);
  assert.deepEqual(await p.entries('rows:box'), [['k', [1, 2]]], `${name}: other namespaces stay`);
  const got = (await p.get('link', 'laptop')) as { cursor: number };
  got.cursor = 99;
  assert.deepEqual(await p.get('link', 'laptop'), { cursor: 9 }, `${name}: values are copies`);
}

test('Persist: memory and IndexedDB keep the same contract', async () => {
  await persistContract('memory', memoryPersist());
  const { idb, range } = fakeIndexedDB();
  await persistContract('indexeddb', indexedDBPersist(idb, range));
});

// ---------- the HTTP transport ----------

function streamOf(chunks: readonly string[]): FetchResponse {
  const bytes = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: { getReader: () => ({ read: async () => (i < bytes.length ? { done: false, value: bytes[i++] } : { done: true }), cancel: async () => {} }) },
  };
}

test('http: one GET streams the frames, split anywhere; the hello rides on the query', async () => {
  const w: ServerMessage = welcome();
  const p: ServerMessage = { t: 'patch', seq: 5, ops: [{ topic: 'list', e: 'session', id: 's1', op: 'del' }] };
  const wire = `retry: 2000\n\n${encodeFrame(null, [w])}: hb\n\n${encodeFrame(5, [p])}`;
  const cut = [wire.slice(0, 7), wire.slice(7, 60), wire.slice(60, 61), wire.slice(61)];
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, ...(init.body !== undefined && { body: init.body }) });
    return init.method === 'GET' ? streamOf(cut) : { ok: true, status: 202, body: null, text: async () => '' };
  };
  const t = httpTransport({ base: 'https://box.example', fetch, headers: () => ({ authorization: 'Bearer tok' }) });
  const frames = [];
  for await (const f of t.connect({ client_id: 'c1', cursor: '4', topics: 'list' }, new AbortController().signal)) frames.push(f);
  assert.deepEqual(frames, [
    { id: null, messages: [w] },
    { id: 5, messages: [p] },
  ]);
  assert.equal(calls[0]?.url, 'https://box.example/api/events?client_id=c1&cursor=4&topics=list');
  assert.equal(calls[0]?.headers['authorization'], 'Bearer tok');
  await t.post({ t: 'sub', topic: 'session:s1' }, new AbortController().signal);
  assert.equal(calls[1]?.url, 'https://box.example/api/events');
  assert.equal(calls[1]?.headers['x-wisp-client'], 'c1', 'names the stream it belongs to');
  assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { t: 'sub', topic: 'session:s1' });
});

test('http: a sleeping box is PeerDown asleep, other failures are unreachable with the status', async () => {
  const fail = (status: number): FetchLike => async () => ({ ok: false, status, body: null, text: async () => 'asleep' });
  const asleep = httpTransport({ base: '', fetch: fail(503), asleep: (s, b) => s === 503 && b === 'asleep' });
  const run = async (t: ReturnType<typeof httpTransport>): Promise<unknown> => {
    try {
      for await (const _ of t.connect({}, new AbortController().signal)) void _;
    } catch (err) {
      return err;
    }
    return undefined;
  };
  const e1 = await run(asleep);
  assert.ok(e1 instanceof PeerDown && e1.status === 'asleep');
  const e2 = await run(httpTransport({ base: '', fetch: fail(502) }));
  assert.ok(e2 instanceof PeerDown && e2.status === 'unreachable' && /HTTP 502/.test(e2.message));
});
