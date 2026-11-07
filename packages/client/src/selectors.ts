// Derived state, kind 2 (plan §4.6.2): computed, never stored, memoised. Every helper takes a
// Readable and returns a Readable, so selectors compose, and a plugin's `api` can hand out
// read-only signals without exposing raw rows.

import { computed, type Readable } from './signals.ts';

// filterBy and sortBy keep their last answer and patch it when the input changed only in place (the
// common case: a token updates one row of 5,000). They scan for the changed slots by reference (no
// predicate or comparator calls on unchanged rows, no allocation when nothing they show changed) and
// fall back to a full pass when a row joins, leaves or moves. Rows are unique objects; an input with
// duplicate references (primitives) always takes the full pass.

/** where each item sits in `out`, or undefined when an item repeats (then no patching) */
function positions<T>(out: readonly T[]): Map<T, number> | undefined {
  const pos = new Map<T, number>();
  for (let i = 0; i < out.length; i++) pos.set(out[i] as T, i);
  return pos.size === out.length ? pos : undefined;
}

export function filterBy<T>(source: Readable<readonly T[]>, keep: (item: T) => boolean): Readable<readonly T[]> {
  let input: readonly T[] | undefined;
  let out: readonly T[] = [];
  let pos: Map<T, number> | undefined;
  const full = (next: readonly T[]): readonly T[] => {
    input = next;
    out = next.filter(keep);
    pos = positions(out);
    return out;
  };
  return computed(() => {
    const next = source();
    if (!input || !pos || next.length !== input.length) return full(next);
    let patched: T[] | undefined;
    for (let i = 0; i < next.length; i++) {
      const was = input[i] as T;
      const is = next[i] as T;
      if (was === is) continue;
      const at = pos.get(was);
      const kept = keep(is);
      if (at === undefined && !kept) continue; // out before and after: nothing shown changed
      if (at === undefined || !kept) return full(next); // joined or left
      patched ??= out.slice();
      patched[at] = is;
      pos.delete(was);
      pos.set(is, at);
    }
    input = next;
    if (patched) out = patched;
    return out; // the same array when nothing shown changed: dependents don't rerun
  });
}

/** A stable sort: rows that compare equal keep their order, so nothing jumps (ADR-0006). */
export function sortBy<T>(source: Readable<readonly T[]>, compare: (a: T, b: T) => number): Readable<readonly T[]> {
  let input: readonly T[] | undefined;
  let out: readonly T[] = [];
  let pos: Map<T, number> | undefined;
  const full = (next: readonly T[]): readonly T[] => {
    input = next;
    out = next.slice().sort(compare);
    pos = positions(out);
    return out;
  };
  // a replaced row may keep its slot only if it still sorts strictly between its neighbours
  const fits = (list: readonly T[], i: number): boolean =>
    (i === 0 || compare(list[i - 1] as T, list[i] as T) < 0) && (i === list.length - 1 || compare(list[i] as T, list[i + 1] as T) < 0);
  return computed(() => {
    const next = source();
    if (!input || !pos || next.length !== input.length) return full(next);
    let patched: T[] | undefined;
    const slots: number[] = [];
    for (let i = 0; i < next.length; i++) {
      const was = input[i] as T;
      const is = next[i] as T;
      if (was === is) continue;
      const at = pos.get(was);
      if (at === undefined) return full(next);
      patched ??= out.slice();
      patched[at] = is;
      slots.push(at);
    }
    if (!patched) return out;
    const p = patched;
    if (!slots.every((at) => fits(p, at))) return full(next);
    for (const at of slots) pos.set(p[at] as T, at);
    input = next;
    out = p;
    return out;
  });
}

export function mapTo<T, U>(source: Readable<readonly T[]>, fn: (item: T) => U): Readable<readonly U[]> {
  return computed(() => source().map(fn));
}

export function count<T>(source: Readable<readonly T[]>, match?: (item: T) => boolean): Readable<number> {
  return computed(() => {
    const list = source();
    if (!match) return list.length;
    let n = 0;
    for (const item of list) if (match(item)) n++;
    return n;
  });
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
