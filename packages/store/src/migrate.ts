// Forward-only migrations, tracked per owner in meta (plan §4.2). Each runs in its own transaction.
// Before upgrading tables that already hold an owner's data, the whole DB is copied with VACUUM INTO,
// so a bad migration costs a restore, not the data. A DB newer than the code is refused: running old
// code on a newer schema is how data gets silently dropped.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StoreError, invalid } from './errors.ts';
import type { Migration } from './types.ts';

const OWNER = /^[a-z0-9][a-z0-9._-]*$/;
/** snapshots kept per owner; older ones are removed after a new one is taken */
const KEEP_SNAPSHOTS = 3;

export interface MigrateEnv {
  db: DatabaseSync;
  /** where backups/ goes; undefined for an in-memory store (no snapshots) */
  home: string | undefined;
  now: number;
}

export interface MigrateReport {
  from: number;
  to: number;
  snapshot?: string;
}

export function schemaVersion(db: DatabaseSync, owner: string): number {
  ensureMeta(db);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`schema:${owner}`);
  return row ? Number(row['value']) : 0;
}

export function runMigrations(env: MigrateEnv, owner: string, migrations: readonly Migration[]): MigrateReport {
  if (!OWNER.test(owner)) throw invalid(`bad migration owner: ${owner}`);
  if (env.db.isTransaction) throw invalid(`migrate(${owner}) inside a transaction: migrations run on their own`);
  checkList(owner, migrations);
  const from = schemaVersion(env.db, owner);
  const known = migrations.length;
  if (from > known) {
    throw new StoreError(
      'conflict',
      `the database has ${owner} schema v${from}, but this wisp only knows up to v${known}: it was written by a newer wisp. Update wisp, or restore a backup from ${env.home ? path.join(env.home, 'backups') : 'backups/'}.`,
    );
  }
  if (from === known) return { from, to: from };
  // A fresh owner (v0) has no data of its own to lose, so it gets no snapshot.
  const snapshot = from > 0 && env.home ? takeSnapshot(env, owner, from) : undefined;
  for (const m of migrations.slice(from)) applyOne(env.db, owner, m);
  return snapshot ? { from, to: known, snapshot } : { from, to: known };
}

function ensureMeta(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
}

function checkList(owner: string, migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw invalid(`${owner} migrations must be numbered 1, 2, 3, … in order; #${i + 1} says v${m.version}`);
  });
}

function applyOne(db: DatabaseSync, owner: string, m: Migration): void {
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
  if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      if (m.foreignKeysOff) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length > 0) throw invalid(`${owner} v${m.version} left ${bad.length} rows with broken foreign keys`);
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`schema:${owner}`, String(m.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err instanceof StoreError ? err : new StoreError('internal', `${owner} migration v${m.version} failed: ${(err as Error).message}`);
    }
  } finally {
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
  }
}

function takeSnapshot(env: MigrateEnv, owner: string, version: number): string {
  const dir = path.join(env.home as string, 'backups'); // caller checked env.home
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${owner}-v${version}-${env.now}.db`);
  fs.rmSync(file, { force: true }); // VACUUM INTO refuses an existing file
  env.db.prepare('VACUUM INTO ?').run(file);
  pruneSnapshots(dir, owner);
  return file;
}

function pruneSnapshots(dir: string, owner: string): void {
  const mine = fs
    .readdirSync(dir)
    .map((f) => ({ f, m: new RegExp(`^${owner.replace(/\./g, '\\.')}-v\\d+-(\\d+)\\.db$`).exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m?.[1]) - Number(a.m?.[1]));
  for (const { f } of mine.slice(KEEP_SNAPSHOTS)) fs.rmSync(path.join(dir, f), { force: true });
}
