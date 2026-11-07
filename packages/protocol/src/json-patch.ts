// JSON Patch (RFC 6902), the subset wisp emits, plus a diff that produces it. Pure and shared: the
// store diffs a row's old and new value into `change.patch`, and every client applies the result.
// Values are plain JSON (no undefined, no functions); objects are never mutated in place.

import type { PatchOp } from './index.ts';

export function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`bad JSON pointer: ${path}`);
  return path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Ops that turn `a` into `b`. Arrays that only grew get `/-` appends; others are replaced whole. */
export function diff(a: unknown, b: unknown, path = ''): PatchOp[] {
  if (deepEqual(a, b)) return [];
  if (isObj(a) && isObj(b)) {
    const ops: PatchOp[] = [];
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) ops.push({ op: 'remove', path: `${path}/${escapePointer(k)}` });
    for (const k of Object.keys(b)) {
      const p = `${path}/${escapePointer(k)}`;
      if (!Object.hasOwn(a, k)) ops.push({ op: 'add', path: p, value: b[k] });
      else ops.push(...diff(a[k], b[k], p));
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && b.length > a.length && a.every((x, i) => deepEqual(x, b[i]))) {
    return b.slice(a.length).map((value) => ({ op: 'add', path: `${path}/-`, value }));
  }
  return [{ op: 'replace', path, value: b }];
}

function setIn(target: unknown, keys: readonly string[], op: PatchOp): unknown {
  if (keys.length === 0) {
    if (op.op === 'remove') return undefined;
    if (op.op === 'test') {
      if (!deepEqual(target, op.value)) throw new Error(`test failed at ${op.path}`);
      return target;
    }
    return op.value;
  }
  const [head, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(target)) {
    const copy = target.slice();
    if (rest.length === 0 && op.op === 'add') {
      const i = head === '-' ? copy.length : Number(head);
      if (!Number.isInteger(i) || i < 0 || i > copy.length) throw new Error(`bad index at ${op.path}`);
      copy.splice(i, 0, op.value);
      return copy;
    }
    const i = Number(head);
    if (!Number.isInteger(i) || i < 0 || i >= copy.length) throw new Error(`no index at ${op.path}`);
    if (rest.length === 0 && op.op === 'remove') {
      copy.splice(i, 1);
      return copy;
    }
    copy[i] = setIn(copy[i], rest, op);
    return copy;
  }
  if (!isObj(target)) throw new Error(`no parent at ${op.path}`);
  if (rest.length === 0 && op.op === 'remove') {
    if (!Object.hasOwn(target, head)) throw new Error(`nothing to remove at ${op.path}`);
    const { [head]: _gone, ...kept } = target;
    return kept;
  }
  if (rest.length > 0 && !Object.hasOwn(target, head)) throw new Error(`no path at ${op.path}`);
  return { ...target, [head]: setIn(target[head], rest, op) };
}

/** Applies ops to a copy of `doc`. Throws on a failed `test` or a path that doesn't exist. */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let out: unknown = doc;
  for (const op of ops) out = setIn(out, parsePointer(op.path), op);
  return out as T;
}
