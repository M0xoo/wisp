import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { INLINE_MAX, hashOf } from '../src/index.ts';
import { open } from './fixture.ts';

const files = (home: string): string[] => {
  const root = path.join(home, 'blobs');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => `${d}/${f}`));
};

test('small blobs are inline and compressed; the same content is stored once', () => {
  const { store } = open({ disk: true });
  const text = 'diff --git a/x b/x\n'.repeat(200);
  const a = store.blobs.put(text, { kind: 'turn', id: 't1' });
  const b = store.blobs.put(Buffer.from(text), { kind: 'turn', id: 't2' });
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, hashOf(Buffer.from(text)));
  assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.inline, true);
  assert.equal(a.codec, typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'br');
  assert.equal(store.blobs.get(a.hash)?.toString(), text);
  assert.equal(store.blobs.refs(a.hash), 2);
  store.close();
});

test('incompressible content is kept raw', () => {
  const { store } = open();
  const info = store.blobs.put(randomBytes(2048));
  assert.equal(info.codec, 'raw');
});

test('big blobs go to blobs/ab/cdef… on disk and read back', () => {
  const { store, home } = open({ disk: true });
  const big = randomBytes(INLINE_MAX + 1);
  const info = store.blobs.put(big, { kind: 'shot', id: 's' });
  assert.equal(info.inline, false);
  const hex = info.hash.slice('sha256:'.length);
  assert.deepEqual(files(home as string), [`${hex.slice(0, 2)}/${hex.slice(2)}`]);
  assert.deepEqual(store.blobs.get(info.hash), big);
  store.close();
});

test('a memory store keeps even big blobs inline', () => {
  const { store } = open();
  const info = store.blobs.put(randomBytes(INLINE_MAX * 2));
  assert.equal(info.inline, true);
  assert.equal(store.blobs.get(info.hash)?.length, INLINE_MAX * 2);
});

test('gc removes unreferenced blobs, rows and files, and keeps referenced ones', () => {
  const { store, home } = open({ disk: true });
  const kept = store.blobs.put('kept', { kind: 'turn', id: 't1' });
  const big = store.blobs.put(randomBytes(INLINE_MAX * 2), { kind: 'turn', id: 't2' });
  const loose = store.blobs.put('never referenced');
  store.blobs.unrefOwner('turn', 't2');
  const r = store.blobs.gc();
  assert.deepEqual(r, { blobs: 2, files: 1, bytes: INLINE_MAX * 2 + 'never referenced'.length });
  assert.equal(store.blobs.has(kept.hash), true);
  assert.equal(store.blobs.has(big.hash), false);
  assert.equal(store.blobs.get(loose.hash), undefined);
  assert.deepEqual(files(home as string), []);
  store.close();
});

test('unref of one owner leaves the others; a ref to a missing blob is refused', () => {
  const { store } = open();
  const b = store.blobs.put('x', { kind: 'turn', id: 'a' });
  store.blobs.ref(b.hash, 'turn', 'b');
  store.blobs.ref(b.hash, 'turn', 'b'); // idempotent
  store.blobs.unref(b.hash, 'turn', 'a');
  assert.equal(store.blobs.refs(b.hash), 1);
  assert.equal(store.blobs.gc().blobs, 0);
  assert.throws(() => store.blobs.ref(`sha256:${'0'.repeat(64)}`, 'turn', 'a'), /no blob/);
});

test('a put in a tx that rolls back leaves no row; its file is swept once it is old', () => {
  const { store, home, clock } = open({ disk: true });
  let hash = '';
  assert.throws(() =>
    store.tx(() => {
      hash = store.blobs.put(randomBytes(INLINE_MAX * 2)).hash;
      throw new Error('rolled back');
    }),
  );
  assert.equal(store.blobs.has(hash), false);
  assert.equal(files(home as string).length, 1, 'the file was written before the row');
  assert.equal(store.blobs.gc().files, 0, 'too young: it might belong to a put still committing');
  clock.t = Date.now() + 11 * 60 * 1000;
  assert.equal(store.blobs.gc().files, 1);
  assert.deepEqual(files(home as string), []);
  store.close();
});

test('a recorded on-disk blob whose file is gone is reported, not returned empty', () => {
  const { store, home } = open({ disk: true });
  const info = store.blobs.put(randomBytes(INLINE_MAX * 2), { kind: 'x', id: '1' });
  for (const f of files(home as string)) fs.rmSync(path.join(home as string, 'blobs', f));
  assert.throws(() => store.blobs.get(info.hash), /file is missing/);
  store.close();
});
