// The grid's database: one SQLite file (node:sqlite, built into Node 22.13+), WAL mode, plain SQL
// migrations below. Only the control process opens it; edges and hosts ask the control process.

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, email TEXT, name TEXT, avatar TEXT,
     created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE identities (
     provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     email TEXT, login TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
   CREATE INDEX identities_user ON identities(user_id);
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ua TEXT);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
     token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
   CREATE TABLE device_codes (
     code_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, user_id TEXT,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, denied_at INTEGER,
     consumed_at INTEGER, last_poll_at INTEGER);
   CREATE TABLE tickets (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
   CREATE TABLE instances (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, host TEXT,
     created_at INTEGER NOT NULL, started_at INTEGER, stopped_at INTEGER, last_active_at INTEGER,
     next_wake_at INTEGER, stop_reason TEXT);
   CREATE TABLE keys (user_id TEXT PRIMARY KEY, kid TEXT NOT NULL, wrapped TEXT NOT NULL);
   CREATE TABLE user_secrets (user_id TEXT NOT NULL, purpose TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (user_id, purpose));
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, meta TEXT, at INTEGER NOT NULL);`,
  // Computers added to the grid (wisp on a desktop: Machines → This computer), one per device,
  // reached at <label>.<domain> through the tunnel the computer holds open (grid/tunnels.js).
  `CREATE TABLE computers (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     device_id TEXT UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE, name TEXT NOT NULL,
     label TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER);
   CREATE INDEX computers_user ON computers(user_id);`,
  // People waiting for a seat (the site's form, or a sign-in the full grid turned away): the
  // oldest get the next seats, held for them a while. How busy the host was, every few minutes,
  // which is what opens seats with auth.maxUsers "auto". And what more people with a seat want
  // (another machine, a bigger one, a GPU), from their account page.
  `CREATE TABLE waitlist (
     email TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL, invited_at INTEGER,
     joined_at INTEGER, user_id TEXT);
   CREATE TABLE load_samples (at INTEGER PRIMARY KEY, running INTEGER NOT NULL, capacity INTEGER NOT NULL, waits INTEGER NOT NULL);
   CREATE TABLE machine_wishes (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, wants TEXT NOT NULL, note TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  // Apps people published from My Stuff (grid/sites.js), open to anyone at <label>.<domain>. key:
  // the item in their My Stuff, so publishing it again updates the same link. db: null, or its
  // database's seed file ('' for none) when its wisp-app.json asks for one (server/app-db.js).
  `CREATE TABLE sites (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
     label TEXT UNIQUE NOT NULL, title TEXT NOT NULL, entry TEXT NOT NULL, files INTEGER NOT NULL,
     size INTEGER NOT NULL, db TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, key));`,
  // Tasks people shared from their wisp (grid/shares.js), at <publicUrl>/s/<id>. key: the task on
  // their wisp, so sharing it again updates the same link. pass: the passkey's scrypt hash, or null.
  `CREATE TABLE shares (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
     title TEXT NOT NULL, pass TEXT, size INTEGER NOT NULL, meta TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, key));`,
];

export async function openDb(dataDir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`wisp Grid needs Node.js 22.13 or newer (it uses the built-in SQLite); this is ${process.version}.`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'grid.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const at = Number(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v || 0);
  for (let i = at; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const cache = new Map();
  const stmt = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    return cache.get(sql);
  };
  return {
    raw: db,
    get: (sql, ...a) => stmt(sql).get(...a),
    all: (sql, ...a) => stmt(sql).all(...a),
    run: (sql, ...a) => stmt(sql).run(...a),
    tx(fn) {
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
    // A consistent copy while running (wisp grid backup).
    backup(file) {
      fs.rmSync(file, { force: true });
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    },
    close: () => db.close(),
  };
}
