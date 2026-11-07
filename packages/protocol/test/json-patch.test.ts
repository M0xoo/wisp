import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, diff } from '../src/index.ts';

// Property: for random JSON pairs, applying diff(a, b) to a gives b, and never mutates a.
function rand(seed: { s: number }): number {
  seed.s = (seed.s * 1103515245 + 12345) & 0x7fffffff;
  return seed.s / 0x7fffffff;
}
function value(seed: { s: number }, depth: number): unknown {
  const r = rand(seed);
  if (depth > 3 || r < 0.3) return [null, true, 1, 'x', 'a/b~c', 2.5][Math.floor(rand(seed) * 6)];
  if (r < 0.6) return Array.from({ length: Math.floor(rand(seed) * 4) }, () => value(seed, depth + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(rand(seed) * 4) }, (_, i) => [`k${i}${rand(seed) < 0.2 ? '/~' : ''}`, value(seed, depth + 1)]));
}

test('diff then apply round-trips random documents', () => {
  const seed = { s: 7 };
  for (let i = 0; i < 2000; i++) {
    const a = value(seed, 0);
    const b = value(seed, 0);
    const before = JSON.stringify(a);
    assert.deepEqual(applyPatch(a, diff(a, b)), b);
    assert.equal(JSON.stringify(a), before);
  }
});

test('an array that only grew becomes appends', () => {
  assert.deepEqual(diff({ e: [1] }, { e: [1, 2, 3] }), [
    { op: 'add', path: '/e/-', value: 2 },
    { op: 'add', path: '/e/-', value: 3 },
  ]);
});

test('a failed test op throws, and so does a missing path', () => {
  assert.throws(() => applyPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]), /test failed/);
  assert.throws(() => applyPatch({}, [{ op: 'replace', path: '/x/y', value: 1 }]), /no path/);
});
