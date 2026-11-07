// Reading the change feed: what a client missed since its cursor, filtered by the topics it watches.
// A change's first topic is on the row; the others are in change_topic, so one write that is on two
// topics is still one change, delivered once.

import type { StatementSync } from 'node:sqlite';
import type { Topic } from '@wisp/protocol';
import { invalid } from './errors.ts';
import type { ChangeOp, ChangeRow } from './types.ts';

const COLS = 'seq, topic, entity, id, op, patch, at';
const MAX_LIMIT = 10_000;

export function readChanges(stmt: (sql: string) => StatementSync, since: number, topics: readonly Topic[] | undefined, limit: number): ChangeRow[] {
  if (!Number.isInteger(since) || since < 0) throw invalid('changesSince: seq must be a whole number ≥ 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid(`changesSince: limit must be 1…${MAX_LIMIT}`);
  if (topics && topics.length === 0) return [];
  let rows;
  if (!topics) rows = stmt(`SELECT ${COLS} FROM change WHERE seq > ? ORDER BY seq LIMIT ?`).all(since, limit);
  else {
    const marks = topics.map(() => '?').join(', ');
    const sql = `SELECT ${COLS} FROM change WHERE seq > ? AND (topic IN (${marks}) OR seq IN (SELECT seq FROM change_topic WHERE topic IN (${marks}) AND seq > ?)) ORDER BY seq LIMIT ?`;
    rows = stmt(sql).all(since, ...topics, ...topics, since, limit);
  }
  if (rows.length === 0) return [];
  const extra = new Map<number, Topic[]>();
  const first = Number(rows[0]?.['seq']);
  const last = Number(rows[rows.length - 1]?.['seq']);
  for (const r of stmt('SELECT seq, topic FROM change_topic WHERE seq BETWEEN ? AND ? ORDER BY seq, topic').all(first, last)) {
    const seq = Number(r['seq']);
    const list = extra.get(seq);
    if (list) list.push(r['topic'] as Topic);
    else extra.set(seq, [r['topic'] as Topic]);
  }
  return rows.map((r) => {
    const seq = Number(r['seq']);
    const topic = r['topic'] as Topic;
    const patch = r['patch'];
    return {
      seq,
      topic,
      topics: [topic, ...(extra.get(seq) ?? [])],
      entity: String(r['entity']),
      id: String(r['id']),
      op: r['op'] as ChangeOp,
      patch: patch === null ? null : JSON.parse(String(patch)),
      at: Number(r['at']),
    };
  });
}
