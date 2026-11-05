// The child process that runs apps' SQL (app-db.js): node:sqlite is synchronous and can't be
// interrupted, so a query that never ends (a recursive CTE) takes this process down, not wisp or
// the grid. Messages in: { id, op: 'query', file, sql, params, seed, maxBytes } or
// { id, op: 'close', file }. Out: { id, started } once its file is open, then { id, rows } | { id, changes, lastId } | { id, error }.

import fs from 'node:fs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
process.send({ ready: !!DatabaseSync });

const MAX_OPEN = 32;
const MAX_ROWS = 10_000;
const open = new Map(); // file -> DatabaseSync, least recently used first

// In PRAGMA user_version while a seed runs (apps can't set it: no PRAGMA in their SQL). The query
// limit covers the seed, and each of its statements commits: a worker stopped halfway leaves a file
// that looks made, and without this the app would stay half seeded for good.
const SEEDING = 0x77697370;

const remove = (file) => {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true, maxRetries: 5 });
};

function connect(file, maxBytes) {
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

// started(): the file is open, and the query's time limit begins. A seed counts as the query.
function db(file, { seed, maxBytes }, started) {
  let d = open.get(file);
  if (d) {
    open.delete(file);
    open.set(file, d);
    started();
    return d;
  }
  d = connect(file, maxBytes);
  let seeding = false;
  try {
    if (d.prepare('PRAGMA user_version').get().user_version === SEEDING) {
      d.close();
      d = null;
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
    d?.close();
    if (!seeding) throw err;
    remove(file);
    throw new Error(`The app's seed.sql failed: ${err.message}`);
  }
  open.set(file, d);
  if (open.size > MAX_OPEN) {
    const [old, od] = open.entries().next().value;
    open.delete(old);
    od.close();
  }
  return d;
}

// Blobs go back as base64; everything else is JSON already (numbers stay numbers).
const plain = (row) => {
  for (const k in row) if (row[k] instanceof Uint8Array) row[k] = Buffer.from(row[k]).toString('base64');
  return row;
};

process.on('message', (m) => {
  try {
    if (m.op === 'close') {
      open.get(m.file)?.close();
      open.delete(m.file);
      return process.send({ id: m.id, ok: true });
    }
    const stmt = db(m.file, m, () => process.send({ id: m.id, started: true })).prepare(m.sql);
    // Reads give rows; writes say what changed (with RETURNING: its rows).
    if (/^\s*(select|with|values)\b/i.test(m.sql) || /\breturning\b/i.test(m.sql)) {
      const rows = stmt.all(...m.params);
      if (rows.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS} rows: add a LIMIT.`);
      return process.send({ id: m.id, rows: rows.map(plain) });
    }
    const r = stmt.run(...m.params);
    process.send({ id: m.id, changes: Number(r.changes), lastId: Number(r.lastInsertRowid) });
  } catch (err) {
    process.send({ id: m.id, error: String(err.message || err).replace(/^SQLITE_\w+: /, '') });
  }
});
