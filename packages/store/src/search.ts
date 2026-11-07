// Full-text search (FTS5) for entity kinds that ask for it. The writer keeps the index in the same
// transaction as the row. FTS5 rowids come from search_doc, not the entity table: an implicit rowid
// may be renumbered by VACUUM, which would point hits at the wrong rows.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { invalid } from './errors.ts';
import type { Kind } from './entity.ts';
import type { Row, SearchHit } from './types.ts';

interface Indexed {
  kind: Kind;
  columns: readonly string[];
  table: string;
}

export class Search {
  readonly #db: DatabaseSync;
  readonly #stmt: (sql: string) => StatementSync;
  readonly #kinds = new Map<string, Indexed>();

  constructor(db: DatabaseSync, stmt: (sql: string) => StatementSync) {
    this.#db = db;
    this.#stmt = stmt;
  }

  has(kind: string): boolean {
    return this.#kinds.has(kind);
  }

  /** Creates the index if needed, and rebuilds it when its column list changed. Runs inside a tx. */
  define(kind: Kind, columns: readonly string[]): void {
    if (columns.length === 0) throw invalid(`${kind.kind}: search needs at least one column`);
    for (const c of columns) if (!kind.cols.includes(c)) throw invalid(`${kind.kind}: unknown column ${c}`);
    const table = `fts_${kind.def.table}`;
    const sig = columns.join(',');
    const was = this.#stmt('SELECT value FROM meta WHERE key = ?').get(`search:${kind.kind}`)?.['value'];
    this.#kinds.set(kind.kind, { kind, columns, table });
    if (was === sig) return;
    this.#db.exec(`DROP TABLE IF EXISTS "${table}"`);
    // contentless + contentless_delete: the text stays in the entity table only, and rows can still
    // be removed by rowid (SQLite ≥ 3.43; node:sqlite ships 3.50+).
    this.#db.exec(`CREATE VIRTUAL TABLE "${table}" USING fts5(${columns.map((c) => `"${c}"`).join(', ')}, content='', contentless_delete=1)`);
    this.#stmt('DELETE FROM search_doc WHERE kind = ?').run(kind.kind);
    for (const raw of this.#stmt(`SELECT ${kind.selectList} FROM "${kind.def.table}"`).iterate()) {
      const row = kind.decode(raw);
      this.index(kind, kind.idOf(row), row);
    }
    this.#stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`search:${kind.kind}`, sig);
  }

  /** Puts a row's text in the index, or takes it out (row undefined). */
  index(kind: Kind, id: string, row: Row | undefined): void {
    const ix = this.#kinds.get(kind.kind);
    if (!ix) return;
    const rid = this.#stmt('SELECT rid FROM search_doc WHERE kind = ? AND id = ?').get(kind.kind, id)?.['rid'];
    if (rid !== undefined) this.#stmt(`DELETE FROM "${ix.table}" WHERE rowid = ?`).run(rid);
    if (!row) {
      if (rid !== undefined) this.#stmt('DELETE FROM search_doc WHERE rid = ?').run(rid);
      return;
    }
    const doc = rid ?? Number(this.#stmt('INSERT INTO search_doc (kind, id) VALUES (?, ?)').run(kind.kind, id).lastInsertRowid);
    const vals = ix.columns.map((c) => textOf(row[c]));
    this.#stmt(`INSERT INTO "${ix.table}" (rowid, ${ix.columns.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${ix.columns.map(() => '?').join(', ')})`).run(doc, ...vals);
  }

  search(text: string, opts: { kinds?: readonly string[]; limit?: number } = {}): SearchHit[] {
    const match = toMatch(text);
    if (!match) return [];
    const limit = opts.limit ?? 50;
    const kinds = opts.kinds ? opts.kinds.map((k) => this.#need(k)) : [...this.#kinds.values()];
    const hits: SearchHit[] = [];
    for (const ix of kinds) {
      const sql = `SELECT d.id AS id, bm25("${ix.table}") AS score FROM "${ix.table}" f JOIN search_doc d ON d.rid = f.rowid WHERE "${ix.table}" MATCH ? ORDER BY score LIMIT ?`;
      for (const r of this.#stmt(sql).all(match, limit)) hits.push({ kind: ix.kind.kind, id: String(r['id']), score: Number(r['score']) });
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  #need(kind: string): Indexed {
    const ix = this.#kinds.get(kind);
    if (!ix) throw invalid(`${kind} has no search index`);
    return ix;
  }
}

function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * What a person types, as an FTS5 query: every word must appear, the last one as a prefix (search as
 * you type). Each word is quoted, so `-`, `:`, `"` or `AND` are text, never query syntax errors.
 */
export function toMatch(text: string): string {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
