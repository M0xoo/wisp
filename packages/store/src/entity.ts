// Entity kinds: how a decoded row (what the change feed and every client see) maps to a table row
// (what SQLite holds). Owners declare their kinds; the store never guesses a table's shape.

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { invalid } from './errors.ts';
import type { ColumnType, EntityDef, EntitySpec, Query, Row, WhereCond, WhereValue } from './types.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TYPES: readonly ColumnType[] = ['text', 'int', 'real', 'bool', 'blob'];

export function defineEntity<R extends Row = Row>(spec: EntitySpec<R>): EntityDef<R> {
  if (!/^[a-z][a-z0-9._-]*$/.test(spec.kind)) throw invalid(`bad entity kind: ${spec.kind}`);
  if (!IDENT.test(spec.table)) throw invalid(`${spec.kind}: bad table name ${spec.table}`);
  const cols = Object.keys(spec.columns);
  for (const c of cols) {
    if (!IDENT.test(c)) throw invalid(`${spec.kind}: bad column name ${c}`);
    if (!TYPES.includes(spec.columns[c as keyof R & string])) throw invalid(`${spec.kind}.${c}: unknown type`);
  }
  if (!cols.includes(spec.key)) throw invalid(`${spec.kind}: key ${spec.key} is not a column`);
  for (const c of spec.json ?? []) if (spec.columns[c] !== 'text') throw invalid(`${spec.kind}.${c}: a json column must be text`);
  if (spec.parent !== undefined && !cols.includes(spec.parent)) throw invalid(`${spec.kind}: parent ${spec.parent} is not a column`);
  return Object.freeze({ ...spec, json: Object.freeze([...(spec.json ?? [])]), __entity: true as const });
}

/** The compiled form the writer and the reads use: column lists and SQL, made once per kind. */
export class Kind {
  readonly def: EntityDef;
  readonly cols: readonly string[];
  readonly json: ReadonlySet<string>;
  readonly bools: ReadonlySet<string>;
  readonly selectList: string;
  readonly getSql: string;
  readonly delSql: string;
  /** per column, how it decodes: 0 as stored, 1 JSON, 2 bool. Arrays, not Sets: decode is hot. */
  readonly #how: readonly (0 | 1 | 2)[];

  constructor(def: EntityDef) {
    this.def = def;
    this.cols = Object.keys(def.columns);
    this.json = new Set(def.json);
    this.bools = new Set(this.cols.filter((c) => def.columns[c] === 'bool'));
    this.#how = this.cols.map((c) => (this.json.has(c) ? 1 : this.bools.has(c) ? 2 : 0));
    this.selectList = this.cols.map((c) => `"${c}"`).join(', ');
    this.getSql = `SELECT ${this.selectList} FROM "${def.table}" WHERE "${def.key}" = ?`;
    this.delSql = `DELETE FROM "${def.table}" WHERE "${def.key}" = ?`;
  }

  get kind(): string {
    return this.def.kind;
  }

  /** The key as it is bound: an int key given as a string ('42') is matched as 42. */
  keyParam(id: string | number): SQLInputValue {
    if (this.def.columns[this.def.key] === 'int' && typeof id === 'string' && /^-?\d+$/.test(id)) return Number(id);
    return id;
  }

  /** Columns present in `row`, in declared order, with their bound values. Unknown columns throw. */
  encode(row: Row): { cols: string[]; vals: SQLInputValue[] } {
    for (const k of Object.keys(row)) if (!this.cols.includes(k)) throw invalid(`${this.kind}: unknown column ${k}`);
    const cols: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const c of this.cols) {
      const v = row[c];
      if (v === undefined) continue;
      cols.push(c);
      vals.push(this.encodeValue(c, v));
    }
    return { cols, vals };
  }

  encodeValue(col: string, v: unknown): SQLInputValue {
    if (v === null) return null;
    if (this.json.has(col)) return JSON.stringify(v);
    if (this.bools.has(col)) {
      if (typeof v !== 'boolean') throw invalid(`${this.kind}.${col}: expected a boolean`);
      return v ? 1 : 0;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
    throw invalid(`${this.kind}.${col}: cannot store a ${typeof v}`);
  }

  /** A stored row as clients see it. `only`: the columns a projection selected (all by default). */
  decode(raw: Record<string, SQLOutputValue>, only?: readonly string[]): Row {
    return this.decodeArray((only ?? this.cols).map((c) => raw[c] ?? null), only);
  }

  /** decode() for a statement in array mode: one value per selected column, in order. */
  decodeArray(vals: readonly SQLOutputValue[], only?: readonly string[]): Row {
    const out: Row = {};
    const cols = only ?? this.cols;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i] as string;
      const v = vals[i];
      const how = only ? this.#how[this.cols.indexOf(c)] : this.#how[i];
      if (v === null || v === undefined) out[c] = null;
      else if (how === 1) out[c] = JSON.parse(v as string);
      else if (how === 2) out[c] = v === 1;
      else out[c] = v;
    }
    return out;
  }

  idOf(row: Row): string {
    const v = row[this.def.key];
    if (v === undefined || v === null) throw invalid(`${this.kind}: row has no ${this.def.key}`);
    return String(v);
  }
}

/** SELECT for a query, and its parameters. Column names are checked, values are always bound. */
export function compileQuery(k: Kind, q: Query): { sql: string; params: SQLInputValue[] } {
  const params: SQLInputValue[] = [];
  const where: string[] = [];
  for (const [col, cond] of Object.entries(q.where ?? {})) {
    if (cond === undefined) continue;
    checkCol(k, col);
    where.push(condition(k, col, cond as WhereCond, params));
  }
  if (q.select) for (const c of q.select) checkCol(k, c);
  const list = q.select && q.select.length > 0 ? q.select.map((c) => `"${c}"`).join(', ') : k.selectList;
  let sql = `SELECT ${list} FROM "${k.def.table}"`;
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  if (q.order && q.order.length > 0) {
    sql += ` ORDER BY ${q.order
      .map(([c, dir]) => {
        checkCol(k, c);
        return `"${c}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      })
      .join(', ')}`;
  }
  if (q.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(intArg(q.limit, 'limit'));
    if (q.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(intArg(q.offset, 'offset'));
    }
  } else if (q.offset !== undefined) throw invalid('offset needs a limit');
  return { sql, params };
}

function checkCol(k: Kind, col: string): void {
  if (!k.cols.includes(col)) throw invalid(`${k.kind}: unknown column ${col}`);
}

function intArg(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw invalid(`${what} must be a whole number ≥ 0`);
  return n;
}

const OPS = { gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '!=', like: 'LIKE' } as const;

function condition(k: Kind, col: string, cond: WhereCond, params: SQLInputValue[]): string {
  const bind = (v: WhereValue): string => {
    params.push(k.encodeValue(col, v));
    return '?';
  };
  if (cond === null) return `"${col}" IS NULL`;
  if (Array.isArray(cond)) {
    const list = cond as readonly WhereValue[];
    if (list.length === 0) return '0';
    return `"${col}" IN (${list.map(bind).join(', ')})`;
  }
  if (typeof cond === 'object') {
    const parts = Object.entries(cond).map(([op, v]) => {
      const sqlOp = OPS[op as keyof typeof OPS];
      if (!sqlOp) throw invalid(`${k.kind}.${col}: unknown operator ${op}`);
      if (v === null) {
        if (op !== 'ne') throw invalid(`${k.kind}.${col}: only ne may compare with null`);
        return `"${col}" IS NOT NULL`;
      }
      return `"${col}" ${sqlOp} ${bind(v as WhereValue)}`;
    });
    return parts.length > 0 ? parts.join(' AND ') : '1';
  }
  return `"${col}" = ${bind(cond)}`;
}
