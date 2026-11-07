// Property: whatever sequence of upsert / patch / del / append runs (including refused ops and
// rolled-back transactions), replaying the change feed over an empty map gives the tables' state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '@wisp/protocol';
import type { PatchOp } from '@wisp/protocol';
import type { ChangeRow, Row, Store, Writer } from '../src/index.ts';
import { open, sessionRow } from './fixture.ts';

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function replay(feed: readonly ChangeRow[]): Map<string, Row> {
  const state = new Map<string, Row>();
  for (const c of feed) {
    const k = `${c.entity}/${c.id}`;
    if (c.op === 'upsert') state.set(k, c.patch as Row);
    else if (c.op === 'patch') state.set(k, applyPatch(state.get(k) as Row, c.patch as PatchOp[]));
    else if (c.op === 'del') state.delete(k);
    else for (const r of c.patch as Row[]) state.set(`${c.entity}/${String(r['id'])}`, r); // both kinds key on id
  }
  return state;
}

function tables(store: Store): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of store.query('session')) out.set(`session/${String(r['id'])}`, r);
  for (const r of store.query('event')) out.set(`event/${String(r['id'])}`, r);
  return out;
}

function randomPatch(r: () => number, row: Row): PatchOp[] {
  const ops: PatchOp[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const pick = r();
    if (pick < 0.3) ops.push({ op: 'replace', path: '/title', value: r() < 0.2 ? null : `t${Math.floor(r() * 5)}` });
    else if (pick < 0.5) ops.push({ op: 'replace', path: '/archived', value: r() < 0.5 });
    else if (pick < 0.7) ops.push({ op: 'replace', path: '/extra', value: { tags: [], n: Math.floor(r() * 3) } });
    else if (pick < 0.85 && row['extra'] !== null) ops.push({ op: 'add', path: '/extra/k', value: [1, 'two', { three: 3 }][Math.floor(r() * 3)] });
    else ops.push({ op: 'replace', path: '/updated_at', value: Math.floor(r() * 100) });
  }
  return ops;
}

function step(w: Writer, r: () => number, store: Store, nextSeq: Map<string, number>): void {
  const id = `s${Math.floor(r() * 6)}`;
  const exists = store.get('session', id);
  const pick = r();
  if (pick < 0.3) w.upsert('session', sessionRow(id, { title: `u${Math.floor(r() * 4)}`, extra: r() < 0.5 ? null : { tags: ['a'] } }));
  else if (pick < 0.55 && exists) w.patch('session', id, randomPatch(r, exists));
  else if (pick < 0.65 && exists) {
    // the session's events go first: the event log references the session
    for (const e of store.query('event', { where: { session_id: id } })) w.del('event', e['id'] as number);
    w.del('session', id);
  } else if (exists) {
    const n = 1 + Math.floor(r() * 4);
    const seq0 = nextSeq.get(id) ?? 0;
    nextSeq.set(id, seq0 + n);
    w.append('event', Array.from({ length: n }, (_, i) => ({ session_id: id, seq: seq0 + i, kind: 'text', body: { i } })));
  }
}

test('replaying the change feed over an empty map equals the final table state', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const { store } = open();
    const nextSeq = new Map<string, number>();
    for (let t = 0; t < 40; t++) {
      const rollBack = r() < 0.1;
      try {
        store.tx((w) => {
          const ops = 1 + Math.floor(r() * 4);
          for (let i = 0; i < ops; i++) step(w, r, store, nextSeq);
          if (rollBack) throw new Error('rolled back');
        });
      } catch (err) {
        if ((err as Error).message !== 'rolled back') throw err;
      }
    }
    const feed = store.changesSince(0, undefined, 10_000);
    assert.deepEqual(replay(feed), tables(store), `seed ${seed}`);
    store.close();
  }
});

test('what listeners hear is exactly what changesSince reads back', () => {
  const r = rng(99);
  const { store } = open();
  const heard: ChangeRow[] = [];
  store.onCommit((c) => heard.push(...c));
  const nextSeq = new Map<string, number>();
  for (let t = 0; t < 60; t++) store.tx((w) => step(w, r, store, nextSeq));
  assert.ok(heard.length > 20);
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), store.changesSince(0, undefined, 10_000));
});
