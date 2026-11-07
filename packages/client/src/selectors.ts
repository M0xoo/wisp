// Derived state, kind 2 (plan §4.6.2): computed, never stored, memoised. Every helper takes a
// Readable and returns a Readable, so selectors compose, and a plugin's `api` can hand out
// read-only signals without exposing raw rows.

import { computed, type Readable } from './signals.ts';

export function filterBy<T>(source: Readable<readonly T[]>, keep: (item: T) => boolean): Readable<readonly T[]> {
  return computed(() => source().filter(keep));
}

/** A stable sort: rows that compare equal keep their order, so nothing jumps (ADR-0006). */
export function sortBy<T>(source: Readable<readonly T[]>, compare: (a: T, b: T) => number): Readable<readonly T[]> {
  return computed(() => source().slice().sort(compare));
}

export function mapTo<T, U>(source: Readable<readonly T[]>, fn: (item: T) => U): Readable<readonly U[]> {
  return computed(() => source().map(fn));
}

export function count<T>(source: Readable<readonly T[]>, match?: (item: T) => boolean): Readable<number> {
  return computed(() => (match ? source().filter(match).length : source().length));
}

export function some<T>(source: Readable<readonly T[]>, match: (item: T) => boolean): Readable<boolean> {
  return computed(() => source().some(match));
}

export function groupBy<T, K>(source: Readable<readonly T[]>, keyOf: (item: T) => K): Readable<ReadonlyMap<K, readonly T[]>> {
  return computed(() => {
    const out = new Map<K, T[]>();
    for (const item of source()) {
      const k = keyOf(item);
      const g = out.get(k);
      if (g) g.push(item);
      else out.set(k, [item]);
    }
    return out;
  });
}

/** Compare helper for sortBy: by a key, then by the next, ascending unless `desc`. */
export function byKeys<T>(...keys: readonly { of: (item: T) => string | number; desc?: boolean }[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const k of keys) {
      const x = k.of(a);
      const y = k.of(b);
      if (x === y) continue;
      return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
    }
    return 0;
  };
}

export interface Family<A, T> {
  (arg: A): Readable<T>;
  /** forget one argument's memo, e.g. when the row it read is gone */
  drop(arg: A): void;
  readonly size: number;
}

/** One memoised selector per argument: `cost(id)` twice returns the same computed. */
export function family<A, T>(make: (arg: A) => Readable<T>, keyOf: (arg: A) => string = String): Family<A, T> {
  const memo = new Map<string, Readable<T>>();
  const get = ((arg: A) => {
    const k = keyOf(arg);
    let s = memo.get(k);
    if (!s) {
      const made = make(arg);
      s = computed(() => made());
      memo.set(k, s);
    }
    return s;
  }) as Family<A, T>;
  Object.defineProperty(get, 'size', { get: () => memo.size });
  get.drop = (arg) => {
    memo.delete(keyOf(arg));
  };
  return get;
}
