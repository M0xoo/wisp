// The grid's control-plane database: one SQLite file (node:sqlite), WAL mode, forward-only SQL
// migrations (plan §4.7). Only the control process opens it; edges and hosts ask the control process.
//
// Not @wisp/store: grid.db is live on every grid today with `meta(k, v)` and a plain schema counter,
// and the grid has no peers to sync with, so the store's change feed would only add write
// amplification. It keeps the store's discipline instead: numbered migrations that only add, each
// in its own transaction, a database newer than the code refused, and a VACUUM INTO copy taken
// before an upgrade touches tables that already hold data.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Db {
  readonly raw: DatabaseSync;
  /** One row, or undefined. T is the row's shape: the caller's SELECT decides it. */
  get<T extends Row = Row>(sql: string, ...params: Param[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: Param[]): T[];
  run(sql: string, ...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  tx<T>(fn: () => T): T;
  /** A consistent copy while running (`wisp grid backup`). */
  backup(file: string): void;
  close(): void;
}

/** Where the copy taken before an upgrade goes, next to grid.db. */
export const backupsDir = (dataDir: string): string => path.join(dataDir, 'backups');

function migrate(db: DatabaseSync, dataDir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
  const at = Number(row?.['v'] ?? 0);
  if (at > MIGRATIONS.length) {
    throw new Error(`grid.db has schema v${at}, but this grid only knows up to v${MIGRATIONS.length}: a newer grid wrote it. Update, or restore a copy from ${backupsDir(dataDir)}.`);
  }
  if (at === MIGRATIONS.length) return;
  // A fresh database has nothing to lose; one with data gets a copy first.
  if (at > 0) {
    fs.mkdirSync(backupsDir(dataDir), { recursive: true });
    const file = path.join(backupsDir(dataDir), `grid-v${at}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }
  for (let i = at; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i] ?? '');
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

async function sqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(`wisp Grid needs Node.js 22.13 or newer (it uses the built-in SQLite); this is ${process.version}.`);
  }
}

export async function openDb(dataDir: string): Promise<Db> {
  const { DatabaseSync } = await sqlite();
  await fs.promises.mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'grid.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, dataDir);
  // Prepared once per SQL text: every query in the grid is a literal, so this stays small.
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    raw: db,
    get: <T extends Row>(sql: string, ...a: Param[]) => stmt(sql).get(...a) as T | undefined,
    all: <T extends Row>(sql: string, ...a: Param[]) => stmt(sql).all(...a) as T[],
    run: (sql, ...a) => stmt(sql).run(...a),
    tx<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    backup(file) {
      fs.rmSync(file, { force: true });
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    },
    close: () => db.close(),
  };
}
