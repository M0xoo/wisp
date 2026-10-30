// The child process that runs apps' SQL (app-db.js): node:sqlite is synchronous and can't be
// interrupted, so a query that never ends (a recursive CTE) takes this process down, not wisp or
// the grid. Messages in: { id, op: 'query', file, sql, params, seed, maxBytes } or
// { id, op: 'close', file }. Out: { id, started } first, then { id, rows } | { id, changes, lastId } | { id, error }.

import fs from 'node:fs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
process.send({ ready: !!DatabaseSync });

const MAX_OPEN = 32;
const MAX_ROWS = 10_000;
const open = new Map(); // file -> DatabaseSync, least recently used first

function db(file, { seed, maxBytes }) {
  let d = open.get(file);
  if (d) {
    open.delete(file);
    open.set(file, d);
    return d;
  }
  const fresh = !fs.existsSync(file);
  d = new DatabaseSync(file);
  try {
    // A cap on its size: max_page_count counts pages of page_size (4096 on a new file).
    d.exec(`PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA max_page_count = ${Math.max(16, Math.ceil(maxBytes / 4096))};`);
    if (fresh && seed) d.exec(seed);
  } catch (err) {
    d.close();
    if (fresh) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
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
  // The parent times the query from here (app-db.js).
  process.send({ id: m.id, started: true });
  try {
    if (m.op === 'close') {
      open.get(m.file)?.close();
      open.delete(m.file);
      return process.send({ id: m.id, ok: true });
    }
    const stmt = db(m.file, m).prepare(m.sql);
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
