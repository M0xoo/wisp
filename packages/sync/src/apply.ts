// Applying what sync delivers to a plain map of entities: the reference semantics every client
// store follows (@wisp/client keeps its own, signal-backed copy of these rules).

import { applyPatch } from '@wisp/protocol';
import type { EntityOp, Topic } from '@wisp/protocol';
import type { Row } from './types.ts';

/** topic → `${e}\u0000${id}` → row */
export type EntityMap = Map<Topic, Map<string, Row>>;

export const rowKey = (e: string, id: string): string => `${e}\u0000${id}`;

export function applySnapshot(map: EntityMap, topic: Topic, rows: readonly Row[]): void {
  map.set(topic, new Map(rows.map((r) => [rowKey(r.e, r.id), r])));
}

/**
 * Applies ops in order. Returns the topics where an op didn't apply (a patch on a missing row, a
 * failed `test`): the caller resubscribes those, since its copy has drifted.
 */
export function applyEntityOps(map: EntityMap, ops: readonly EntityOp[]): Topic[] {
  const failed: Topic[] = [];
  for (const op of ops) {
    let rows = map.get(op.topic);
    if (rows === undefined) {
      rows = new Map();
      map.set(op.topic, rows);
    }
    const key = rowKey(op.e, op.id);
    const cur = rows.get(key);
    try {
      switch (op.op) {
        case 'upsert':
          rows.set(key, { e: op.e, id: op.id, v: op.v });
          break;
        case 'del':
          rows.delete(key);
          break;
        case 'patch':
          if (cur === undefined) throw new Error('patch on a missing row');
          rows.set(key, { e: op.e, id: op.id, v: applyPatch(cur.v, op.ops) });
          break;
        case 'append': {
          if (cur !== undefined && !Array.isArray(cur.v)) throw new Error('append to a row that is not a list');
          const prev: unknown[] = cur === undefined ? [] : (cur.v as unknown[]);
          rows.set(key, { e: op.e, id: op.id, v: [...prev, ...op.v] });
          break;
        }
      }
    } catch {
      if (!failed.includes(op.topic)) failed.push(op.topic);
    }
  }
  return failed;
}
