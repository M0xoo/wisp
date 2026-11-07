// The child process that runs apps' SQL (v1 server/app-db-worker.js), started through the proc
// service by app-db.ts. node:sqlite is synchronous and can't be interrupted (Worker.terminate doesn't
// stop a running step either), so a query that never ends takes this process down, not wisp: the
// parent kills it. Being its own process, the synchronous calls here block nobody else.
//
// One JSON message per line. In: { id, op: 'query', file, sql, params, seed, maxBytes } or
// { id, op: 'close', file }. Out: { ready } first; then { id, started } once its file is open, then
// { id, rows } | { id, changes, lastId } | { id, error } | { id, ok }.

import fs from 'node:fs';
import type { DatabaseSync as Db, SQLInputValue } from 'node:sqlite';
import { jsonLines, line } from '../lines.ts';

const send = (msg: unknown): void => void process.stdout.write(line(msg));

let DatabaseSync: (new (file: string) => Db) | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // an older Node: every query answers that it needs a newer one (app-db.ts)
}
send({ ready: !!DatabaseSync });

const MAX_OPEN = 32;
const MAX_ROWS = 10_000;
const open = new Map<string, Db>(); // file -> database, least recently used first

// In PRAGMA user_version while a seed runs (apps can't set it: no PRAGMA in their SQL). The query
// limit covers the seed, and each of its statements commits: a worker stopped halfway leaves a file
// that looks made, and without this the app would stay half seeded for good.
const SEEDING = 0x77697370;

const remove = (file: string): void => {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true, maxRetries: 5 });
};

function connect(file: string, maxBytes: number): Db {
  if (!DatabaseSync) throw new Error('no node:sqlite');
  const d = new DatabaseSync(file);
  try {
    // A cap on its size: max_page_count counts pages of page_size (4096 on a new file).
    d.exec(`PRAGMA busy_timeout = 2000; PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; PRAGMA max_page_count = ${Math.max(16, Math.ceil(maxBytes / 4096))};`);
  } catch (err) {
    d.close();
    throw err;
  }
  return d;
}

interface Query {
  id: number;
  op: string;
  file: string;
  sql: string;
  params: SQLInputValue[];
  seed: string;
  maxBytes: number;
}

// started(): the file is open, and the query's time limit begins. A seed counts as the query.
function db(m: Query, started: () => void): Db {
  const had = open.get(m.file);
  if (had) {
    open.delete(m.file);
    open.set(m.file, had);
    started();
    return had;
  }
  let d: Db | null = connect(m.file, m.maxBytes);
  let seeding = false;
  try {
    if (d.prepare('PRAGMA user_version').get()?.['user_version'] === SEEDING) {
      d.close();
      d = null;
      remove(m.file);
      d = connect(m.file, m.maxBytes);
    }
    started();
    // No tables yet: new, or left by a worker stopped before its seed's first commit.
    if (m.seed && !d.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      d.exec(`PRAGMA user_version = ${SEEDING};`);
      seeding = true;
      d.exec(m.seed);
      d.exec('PRAGMA user_version = 0;');
    }
  } catch (err) {
    d?.close();
    if (!seeding) throw err;
    remove(m.file);
    throw new Error(`The app's seed.sql failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  open.set(m.file, d);
  if (open.size > MAX_OPEN) {
    const [old, od] = open.entries().next().value ?? [];
    if (old !== undefined) open.delete(old);
    od?.close();
  }
  return d;
}

// Blobs go back as base64; everything else is JSON already (numbers stay numbers).
const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  for (const k in row) if (row[k] instanceof Uint8Array) row[k] = Buffer.from(row[k]).toString('base64');
  return row;
};

function run(m: Query): void {
  if (m.op === 'close') {
    open.get(m.file)?.close();
    open.delete(m.file);
    return send({ id: m.id, ok: true });
  }
  const stmt = db(m, () => send({ id: m.id, started: true })).prepare(m.sql);
  // Reads give rows; writes say what changed (with RETURNING: its rows).
  if (/^\s*(select|with|values)\b/i.test(m.sql) || /\breturning\b/i.test(m.sql)) {
    const rows = stmt.all(...m.params);
    if (rows.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS} rows: add a LIMIT.`);
    return send({ id: m.id, rows: rows.map((r) => plain({ ...r })) });
  }
  const r = stmt.run(...m.params);
  send({ id: m.id, changes: Number(r.changes), lastId: Number(r.lastInsertRowid) });
}

process.stdin.on(
  'data',
  jsonLines((msg) => {
    const m = msg as unknown as Query;
    try {
      run(m);
    } catch (err) {
      send({ id: m.id, error: String(err instanceof Error ? err.message : err).replace(/^SQLITE_\w+: /, '') });
    }
  }),
);
