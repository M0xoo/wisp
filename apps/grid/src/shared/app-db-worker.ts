// Copy of v1 server/app-db-worker.js; see app-db.ts. The child process that runs apps' SQL:
// node:sqlite is synchronous and can't be interrupted, so a query that never ends (a recursive CTE)
// takes this process down, not the grid. Sync calls are the point here: it's its own process.
// Messages in: { id, op: 'query', file, sql, params, seed, maxBytes } or { id, op: 'close', file }.
// Out: { id, started } once its file is open, then { id, rows } | { id, changes, lastId } | { id, error }.

import fs from 'node:fs';
import type { DatabaseSync as Db, SQLInputValue } from 'node:sqlite';

type Ctor = typeof import('node:sqlite').DatabaseSync;
let DatabaseSync: Ctor | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // too old a Node: the parent says so to the app
}
const reply = (m: Record<string, unknown>): void => void process.send?.(m);
reply({ ready: !!DatabaseSync });

const MAX_OPEN = 32;
const MAX_ROWS = 10_000;
const open = new Map<string, Db>(); // file -> database, least recently used first

// In PRAGMA user_version while a seed runs (apps can't set it: no PRAGMA in their SQL). A worker
// stopped halfway leaves a file that looks made; this says it isn't.
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

interface Msg {
  id: number;
  op: 'query' | 'close';
  file: string;
  sql: string;
  params: SQLInputValue[];
  seed: string;
  maxBytes: number;
}

// started(): the file is open, and the query's time limit begins. A seed counts as the query.
function db(file: string, { seed, maxBytes }: Msg, started: () => void): Db {
  const have = open.get(file);
  if (have) {
    open.delete(file);
    open.set(file, have);
    started();
    return have;
  }
  let d = connect(file, maxBytes);
  let seeding = false;
  try {
    if (d.prepare('PRAGMA user_version').get()?.['user_version'] === SEEDING) {
      d.close();
      remove(file);
      d = connect(file, maxBytes);
    }
    started();
    // No tables yet: new, or left by a worker stopped before its seed's first commit.
    if (seed && !d.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      d.exec(`PRAGMA user_version = ${SEEDING};`);
      seeding = true;
      d.exec(seed);
      d.exec('PRAGMA user_version = 0;');
    }
  } catch (err) {
    d.close();
    if (!seeding) throw err;
    remove(file);
    throw new Error(`The app's seed.sql failed: ${(err as Error).message}`);
  }
  open.set(file, d);
  if (open.size > MAX_OPEN) {
    const first = open.entries().next().value;
    if (first) {
      open.delete(first[0]);
      first[1].close();
    }
  }
  return d;
}

// Blobs go back as base64; everything else is JSON already (numbers stay numbers).
const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  for (const k in row) if (row[k] instanceof Uint8Array) row[k] = Buffer.from(row[k]).toString('base64');
  return row;
};

process.on('message', (m: Msg) => {
  try {
    if (m.op === 'close') {
      open.get(m.file)?.close();
      open.delete(m.file);
      return reply({ id: m.id, ok: true });
    }
    const stmt = db(m.file, m, () => reply({ id: m.id, started: true })).prepare(m.sql);
    // Reads give rows; writes say what changed (with RETURNING: its rows).
    if (/^\s*(select|with|values)\b/i.test(m.sql) || /\breturning\b/i.test(m.sql)) {
      const rows = stmt.all(...m.params);
      if (rows.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS} rows: add a LIMIT.`);
      return reply({ id: m.id, rows: rows.map((r) => plain(r as Record<string, unknown>)) });
    }
    const r = stmt.run(...m.params);
    reply({ id: m.id, changes: Number(r.changes), lastId: Number(r.lastInsertRowid) });
  } catch (err) {
    reply({ id: m.id, error: String((err as Error).message || err).replace(/^SQLITE_\w+: /, '') });
  }
});
