// Change rows as the store's onCommit reports them, turned into the wire's entity ops.

import type { EntityOp, PatchOp } from '@wisp/protocol';
import type { ChangeRow } from './types.ts';

/** the JSON around one entity op: {"topic":…,"e":…,"id":…,"op":…} */
export const OVERHEAD = 48;

export function toEntityOp(row: ChangeRow): EntityOp {
  const base = { topic: row.topic, e: row.entity, id: row.id };
  switch (row.op) {
    case 'upsert':
      return { ...base, op: 'upsert', v: row.patch };
    case 'patch':
      return { ...base, op: 'patch', ops: Array.isArray(row.patch) ? (row.patch as PatchOp[]) : [] };
    case 'append':
      return { ...base, op: 'append', v: Array.isArray(row.patch) ? row.patch : [row.patch] };
    case 'del':
      return { ...base, op: 'del' };
  }
}

export function rowBytes(row: ChangeRow): number {
  return (row.patch === undefined || row.patch === null ? 0 : JSON.stringify(row.patch).length) + row.topic.length + row.entity.length + row.id.length + OVERHEAD;
}
