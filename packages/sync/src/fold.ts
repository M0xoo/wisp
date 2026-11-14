// Folding queued entity ops (plan §4.4). Pure: `fold(queued, next)` returns the ops that have the
// same effect on any client state as applying `queued` then `next`, but usually fewer of them.
//
//   upsert wins · a del drops what was queued · appends join · patches compose
//
// A fold that can't be proven equal keeps both ops in order: folding is an optimisation, never a
// change of meaning (the property test in test/fold.test.ts checks this on random histories).

import { applyPatch, parsePointer } from '@wisp/protocol';
import type { EntityOp, PatchOp } from '@wisp/protocol';

export function fold(queued: readonly EntityOp[], next: EntityOp): EntityOp[] {
  if (next.op === 'upsert' || next.op === 'del') return [next];
  const last = queued.at(-1);
  if (last === undefined) return [next];
  const head = queued.slice(0, -1);
  const merged = foldPair(last, next);
  return merged === null ? [...queued, next] : [...head, merged];
}

function foldPair(prev: EntityOp, next: EntityOp): EntityOp | null {
  if (next.op === 'patch') {
    if (prev.op === 'upsert') {
      try {
        return { ...prev, v: applyPatch(prev.v, next.ops) };
      } catch {
        return null; // a patch that doesn't apply is the client's to report, unchanged
      }
    }
    if (prev.op === 'patch') return { ...prev, ops: compose(prev.ops, next.ops) };
    return null;
  }
  if (next.op === 'append') {
    if (prev.op === 'append') return { ...prev, v: [...prev.v, ...next.v] };
    if (prev.op === 'upsert' && Array.isArray(prev.v)) return { ...prev, v: [...prev.v, ...next.v] };
    return null;
  }
  return null;
}

/** `a` then `b`, dropping ops of `a` that a later replace or remove in `b` makes dead. */
export function compose(a: readonly PatchOp[], b: readonly PatchOp[]): PatchOp[] {
  const out = a.slice();
  for (const op of b) {
    const target = objectPath(op);
    if (target !== null && (op.op === 'replace' || op.op === 'remove' || op.op === 'add')) {
      let next: PatchOp = op;
      for (let i = out.length - 1; i >= 0; i--) {
        const prev = out[i] as PatchOp; // i is in range
        const keys = parsePointer(prev.path);
        if (isPrefix(keys, target, true)) break; // an ancestor changed: order matters
        if (isPrefix(target, keys, false)) {
          if (prev.op === 'test') break;
          // prev writes inside what `op` overwrites whole
          if (prev.op === 'add' && keys.length === target.length) {
            if (op.op === 'remove') break; // the key may not have existed before prev
            if (op.op === 'replace') next = { op: 'add', path: op.path, value: op.value };
          }
          out.splice(i, 1);
        }
      }
      out.push(next);
    } else out.push(op);
  }
  return out;
}

/** The path's keys when every segment is an object key; arrays shift indexes, so they never fold. */
function objectPath(op: PatchOp): string[] | null {
  const keys = parsePointer(op.path);
  if (keys.length === 0) return null;
  for (const k of keys) if (k === '-' || /^\d+$/.test(k)) return null;
  return keys;
}

/** `p` is a prefix of `q` (strictly shorter when `strict`). */
function isPrefix(p: readonly string[], q: readonly string[], strict: boolean): boolean {
  if (p.length > q.length || (strict && p.length === q.length)) return false;
  return p.every((k, i) => k === q[i]);
}
