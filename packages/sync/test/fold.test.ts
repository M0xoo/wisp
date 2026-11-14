import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '@wisp/protocol';
import type { EntityOp, PatchOp } from '@wisp/protocol';
import { compose, fold } from '../src/fold.ts';
import { applyEntityOps } from '../src/apply.ts';
import type { EntityMap } from '../src/apply.ts';
import { rng } from './harness.ts';

const T = { topic: 'list' as const, e: 'row', id: 'r1' };

function obj(r: () => number, depth = 0): unknown {
  const out: Record<string, unknown> = {};
  for (const k of ['a', 'b', 'c', 'd/e', '0']) {
    const x = r();
    if (x < 0.3) continue;
    if (x < 0.5 && depth < 2) out[k] = obj(r, depth + 1);
    else if (x < 0.65) out[k] = Array.from({ length: Math.floor(r() * 3) }, (_, i) => i);
    else out[k] = Math.floor(r() * 4);
  }
  return out;
}

/** A random history for one entity, valid against the true state at every step. */
function history(r: () => number, n: number): EntityOp[] {
  const ops: EntityOp[] = [];
  let cur: unknown;
  let list: unknown[] | undefined;
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.15) {
      ops.push({ ...T, op: 'del' });
      cur = undefined;
      list = undefined;
    } else if (k < 0.3 || (cur === undefined && list === undefined)) {
      if (r() < 0.3) {
        list = [i];
        cur = undefined;
        ops.push({ ...T, op: 'upsert', v: list });
      } else {
        cur = obj(r);
        list = undefined;
        ops.push({ ...T, op: 'upsert', v: cur });
      }
    } else if (list !== undefined) {
      const add = [i, i + 1].slice(0, 1 + Math.floor(r() * 2));
      list = [...list, ...add];
      ops.push({ ...T, op: 'append', v: add });
    } else {
      const next = obj(r);
      const p = diff(cur, next);
      if (p.length === 0) continue;
      ops.push({ ...T, op: 'patch', ops: p });
      cur = next;
    }
  }
  return ops;
}

const apply = (ops: EntityOp[], start?: EntityMap): EntityMap => {
  const m: EntityMap = start ?? new Map();
  assert.deepEqual(applyEntityOps(m, ops), []);
  return m;
};

test('folding a history one op at a time has the same effect as the history', () => {
  const r = rng(5);
  let total = 0;
  let folded = 0;
  for (let round = 0; round < 3000; round++) {
    const h = history(r, 1 + Math.floor(r() * 12));
    let queued: EntityOp[] = [];
    for (const op of h) queued = fold(queued, op);
    assert.deepEqual(apply(queued), apply(h));
    total += h.length;
    folded += queued.length;
  }
  assert.ok(folded < total / 2, `folding should at least halve the ops (${folded} of ${total})`);
});

test('folding after the client already holds a value is still equal', () => {
  const r = rng(11);
  for (let round = 0; round < 2000; round++) {
    const h = history(r, 2 + Math.floor(r() * 10));
    const split = 1 + Math.floor(r() * (h.length - 1));
    const base = apply(h.slice(0, split));
    let queued: EntityOp[] = [];
    for (const op of h.slice(split)) queued = fold(queued, op);
    const clone: EntityMap = new Map([...base].map(([t, rows]) => [t, new Map(rows)]));
    assert.deepEqual(apply(queued, clone), apply(h.slice(split), base));
  }
});

test('the rules by name', () => {
  const up = (v: unknown): EntityOp => ({ ...T, op: 'upsert', v });
  const patch = (...ops: PatchOp[]): EntityOp => ({ ...T, op: 'patch', ops });
  const app = (...v: unknown[]): EntityOp => ({ ...T, op: 'append', v });
  assert.deepEqual(fold([patch({ op: 'replace', path: '/a', value: 1 })], up({ a: 2 })), [up({ a: 2 })], 'upsert wins');
  assert.deepEqual(fold([up({ a: 1 }), app(1)], { ...T, op: 'del' }), [{ ...T, op: 'del' }], 'a del drops what was queued');
  assert.deepEqual(fold([app(1)], app(2, 3)), [app(1, 2, 3)], 'appends join');
  assert.deepEqual(fold([up([1])], app(2)), [up([1, 2])], 'an append onto a queued list');
  assert.deepEqual(fold([up({ a: 1 })], patch({ op: 'replace', path: '/a', value: 2 })), [up({ a: 2 })], 'a patch folds into an upsert');
  assert.deepEqual(fold([patch({ op: 'replace', path: '/live', value: 'Reading' })], patch({ op: 'replace', path: '/live', value: 'Editing' })), [patch({ op: 'replace', path: '/live', value: 'Editing' })], 'a newer value replaces an older one');
});

test('compose keeps order where it matters', () => {
  const add: PatchOp = { op: 'add', path: '/x', value: 1 };
  // the key may not have existed before the add: the remove can't stand alone
  assert.deepEqual(compose([add], [{ op: 'remove', path: '/x' }]), [add, { op: 'remove', path: '/x' }]);
  // an add then a replace of the same key is one add
  assert.deepEqual(compose([add], [{ op: 'replace', path: '/x', value: 2 }]), [{ op: 'add', path: '/x', value: 2 }]);
  // array indexes shift: never folded
  const arr: PatchOp[] = [{ op: 'add', path: '/l/0', value: 1 }];
  assert.deepEqual(compose(arr, [{ op: 'replace', path: '/l/0', value: 2 }]).length, 2);
  // a parent replaced in between: the child op stays behind it
  const seq: PatchOp[] = [{ op: 'replace', path: '/a/b', value: 1 }, { op: 'replace', path: '/a', value: { b: 0 } }];
  assert.deepEqual(compose(seq, [{ op: 'replace', path: '/a/b', value: 2 }]), [...seq, { op: 'replace', path: '/a/b', value: 2 }]);
  // a whole object replaced drops the writes inside it
  assert.deepEqual(compose([{ op: 'replace', path: '/a/b', value: 1 }, { op: 'add', path: '/a/c/-', value: 1 }], [{ op: 'replace', path: '/a', value: 3 }]), [{ op: 'replace', path: '/a', value: 3 }]);
});
