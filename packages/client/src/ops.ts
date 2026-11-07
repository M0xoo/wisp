// One entity op applied to one row value. Shared by server patches and optimistic overlays, so a
// command's declared patch means exactly what the same patch from the server would mean.

import { applyPatch, type EntityOp, type PatchOp } from '@wisp/protocol';
import type { EntityKey } from './types.ts';

/** An op as a command declares it: like the wire's EntityOp, keyed by entity key, no topic. */
export type LocalOp =
  | { e: string; id: EntityKey; op: 'upsert'; v: unknown }
  | { e: string; id: EntityKey; op: 'patch'; ops: PatchOp[] }
  | { e: string; id: EntityKey; op: 'del' }
  | { e: string; id: EntityKey; op: 'append'; v: unknown[] };
export type EntityOps = readonly LocalOp[];

type AnyOp = LocalOp | EntityOp;

/** The row's next value; `undefined` means the row is gone. Throws when the op doesn't fit. */
export function applyOp(current: unknown, op: AnyOp): unknown {
  switch (op.op) {
    case 'upsert':
      return op.v;
    case 'del':
      return undefined;
    case 'patch':
      if (current === undefined) throw new Error(`patch on a missing ${op.e} ${op.id}`);
      return applyPatch(current, op.ops);
    case 'append':
      if (current === undefined) return op.v.slice();
      if (!Array.isArray(current)) throw new Error(`append on a non-list ${op.e} ${op.id}`);
      return current.concat(op.v);
  }
}
