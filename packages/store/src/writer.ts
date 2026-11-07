// The one write path (ADR-0004): every entity op writes its table row and its change row in the
// caller's transaction. The change patch is the RFC 6902 diff between the decoded old and new rows,
// so what clients apply is exactly what the table now holds, not what the caller asked for.

import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { applyPatch, deepEqual, diff, isTopic } from '@wisp/protocol';
import type { PatchOp, Topic } from '@wisp/protocol';
import { StoreError, invalid } from './errors.ts';
import type { Kind } from './entity.ts';
import type { ChangeOp, ChangeRow, EntityRef, Row, Writer } from './types.ts';

/** What the writer needs from the store; one per open transaction. */
export interface WriteCtx {
  stmt(sql: string): StatementSync;
  kind(ref: EntityRef): Kind;
  now(): number;
  /** committed after the outermost tx ends; published to onCommit listeners */
  pending: ChangeRow[];
  /** keeps FTS5 in step with a searched kind; row is undefined for a delete */
  reindex(kind: Kind, id: string, row: Row | undefined): void;
}

type Raw = Record<string, SQLOutputValue>;

export function makeWriter(ctx: WriteCtx): Writer {
  return {
    upsert: <R extends Row>(ref: EntityRef<R>, row: Partial<R>): R => upsert(ctx, ctx.kind(ref as EntityRef), row) as R,
    patch: <R extends Row>(ref: EntityRef<R>, id: string | number, ops: readonly PatchOp[]): R => patch(ctx, ctx.kind(ref as EntityRef), id, ops) as R,
    del: (ref, id) => del(ctx, ctx.kind(ref), id),
    append: <R extends Row>(ref: EntityRef<R>, rows: readonly R[]): R[] => append(ctx, ctx.kind(ref as EntityRef), rows) as R[],
  };
}

export function readRow(ctx: Pick<WriteCtx, 'stmt'>, k: Kind, id: string | number): Row | undefined {
  const raw = ctx.stmt(k.getSql).get(k.keyParam(id));
  return raw ? k.decode(raw) : undefined;
}

function upsert(ctx: WriteCtx, k: Kind, row: Row): Row {
  const id = k.idOf(row);
  const old = readRow(ctx, k, row[k.def.key] as string | number);
  if (old && deepEqual({ ...old, ...defined(row) }, old)) return old; // nothing to write, nothing to tell
  const { cols, vals } = k.encode(row);
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const others = cols.filter((c) => c !== k.def.key);
  const set = (others.length > 0 ? others : [k.def.key]).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  const sql = `INSERT INTO "${k.def.table}" (${quoted}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT ("${k.def.key}") DO UPDATE SET ${set} RETURNING ${k.selectList}`;
  const next = k.decode(run(ctx.stmt(sql), vals, k) as Raw);
  if (old) record(ctx, k, 'patch', id, diff(old, next), topicsOf(k, old, next));
  else record(ctx, k, 'upsert', id, next, topicsOf(k, next));
  ctx.reindex(k, id, next);
  return next;
}

function patch(ctx: WriteCtx, k: Kind, id: string | number, ops: readonly PatchOp[]): Row {
  const old = readRow(ctx, k, id);
  if (!old) throw new StoreError('not_found', `${k.kind} ${id} does not exist`);
  let next: unknown;
  try {
    next = applyPatch(old, ops);
  } catch (err) {
    throw invalid(`${k.kind} ${id}: ${(err as Error).message}`);
  }
  if (typeof next !== 'object' || next === null || Array.isArray(next)) throw invalid(`${k.kind} ${id}: a patch must leave an object`);
  const want = next as Row;
  for (const key of Object.keys(want)) if (!k.cols.includes(key)) throw invalid(`${k.kind}: unknown column ${key}`);
  if (!deepEqual(want[k.def.key], old[k.def.key])) throw invalid(`${k.kind} ${id}: a patch cannot change ${k.def.key}`);
  const changed = k.cols.filter((c) => !deepEqual(want[c] ?? null, old[c]));
  if (changed.length === 0) return old;
  const sql = `UPDATE "${k.def.table}" SET ${changed.map((c) => `"${c}" = ?`).join(', ')} WHERE "${k.def.key}" = ? RETURNING ${k.selectList}`;
  const vals = [...changed.map((c) => k.encodeValue(c, want[c] ?? null)), k.keyParam(id)];
  const stored = k.decode(run(ctx.stmt(sql), vals, k) as Raw);
  const sid = String(id);
  record(ctx, k, 'patch', sid, diff(old, stored), topicsOf(k, old, stored));
  ctx.reindex(k, sid, stored);
  return stored;
}

function del(ctx: WriteCtx, k: Kind, id: string | number): boolean {
  const old = readRow(ctx, k, id);
  if (!old) return false;
  ctx.stmt(k.delSql).run(k.keyParam(id));
  const sid = String(id);
  record(ctx, k, 'del', sid, null, topicsOf(k, old));
  ctx.reindex(k, sid, undefined);
  return true;
}

function append(ctx: WriteCtx, k: Kind, rows: readonly Row[]): Row[] {
  const stored: Row[] = [];
  // Appends are grouped under their parent (a session's events), so one change row carries a batch.
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const { cols, vals } = k.encode(row);
    const sql = `INSERT INTO "${k.def.table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING ${k.selectList}`;
    const next = k.decode(run(ctx.stmt(sql), vals, k) as Raw);
    stored.push(next);
    const group = k.def.parent ? String(next[k.def.parent]) : k.idOf(next);
    const list = groups.get(group);
    if (list) list.push(next);
    else groups.set(group, [next]);
    ctx.reindex(k, k.idOf(next), next);
  }
  for (const [group, list] of groups) record(ctx, k, 'append', group, list, topicsOf(k, ...list));
  return stored;
}

function run(stmt: StatementSync, vals: SQLInputValue[], k: Kind): Raw | undefined {
  try {
    return stmt.get(...vals);
  } catch (err) {
    const msg = (err as Error).message;
    if (/UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK|NOT NULL/.test(msg)) throw new StoreError('conflict', `${k.kind}: ${msg}`);
    if (/cannot store|datatype mismatch/i.test(msg)) throw invalid(`${k.kind}: ${msg}`);
    throw err;
  }
}

function defined(row: Row): Row {
  const out: Row = {};
  for (const [c, v] of Object.entries(row)) if (v !== undefined) out[c] = v;
  return out;
}

function topicsOf(k: Kind, ...rows: Row[]): Topic[] {
  const out: Topic[] = [];
  for (const r of rows) for (const t of k.def.topics(r)) if (!out.includes(t)) out.push(t);
  if (out.length === 0) throw invalid(`${k.kind}: every row must be on at least one topic`);
  for (const t of out) if (!isTopic(t)) throw invalid(`${k.kind}: bad topic ${t}`);
  return out;
}

const INSERT_CHANGE = 'INSERT INTO change (topic, entity, id, op, patch, at) VALUES (?, ?, ?, ?, ?, ?)';
const INSERT_TOPIC = 'INSERT INTO change_topic (topic, seq) VALUES (?, ?)';

function record(ctx: WriteCtx, k: Kind, op: ChangeOp, id: string, patch: unknown, topics: Topic[]): void {
  if (op === 'patch' && Array.isArray(patch) && patch.length === 0) return;
  const at = ctx.now();
  const [topic, ...others] = topics as [Topic, ...Topic[]]; // topicsOf never returns an empty list
  const rest = others.sort(); // the order the feed reads them back in
  const res = ctx.stmt(INSERT_CHANGE).run(topic, k.kind, id, op, patch === null ? null : JSON.stringify(patch), at);
  const seq = Number(res.lastInsertRowid);
  for (const t of rest) ctx.stmt(INSERT_TOPIC).run(t, seq);
  ctx.pending.push({ seq, topic, topics: [topic, ...rest], entity: k.kind, id, op, patch, at });
}
