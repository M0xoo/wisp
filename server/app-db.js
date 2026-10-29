// An app's own SQLite database, for demo apps that keep data (a todo list, a form's entries, a
// game's scores). Off unless the app's wisp-app.json says "db": true (or names its seed file:
// "db": "seed.sql", run once when the database is made). The app reaches it on its own origin:
//
//   import { sql } from '/_wisp/db.js';
//   await sql('INSERT INTO todos (text) VALUES (?)', text);    // → { changes, lastId }
//   const rows = await sql('SELECT * FROM todos');            // → [{ id, text }, …]
//
// Launched in wisp, the file sits beside the app in My Stuff (services/apps.js); published, the
// grid keeps one of its own for everyone who opens the link (grid/sites.js). Queries run in a
// child process (app-db-worker.js) that's killed when one runs too long. Needs node:sqlite
// (Node 22.13+); on an older Node the endpoint says so.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundlePath } from './bundle.js';

const WORKER = fileURLToPath(new URL('./app-db-worker.js', import.meta.url));
const BODY_LIMIT = 1024 * 1024;
// Nothing that reaches past the app's own file (ATTACH writes anywhere), loads code, or changes
// the limits set on it. Whole words, so a string that merely says them is refused too: rare.
const DENY = /\b(attach|detach|pragma|vacuum|load_extension|sqlite_dbpage)\b/i;

// The page side, served at /_wisp/db.js.
export const DB_CLIENT = `// This app's database (wisp). sql(query, ...params): rows for a read, { changes, lastId } for a write.
export async function sql(query, ...params) {
  const r = await fetch('/_wisp/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: String(query), params }) });
  const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j.rows || j;
}
export default sql;
`;

// What wisp-app.json's "db" asks for: null (off), or { seed } (a file in the app, or none).
export function dbSpec(manifest, exists = () => false) {
  const d = manifest?.db;
  if (!d) return null;
  if (typeof d === 'string') {
    const seed = bundlePath(d.replace(/^\/+/, ''));
    if (!seed) throw Object.assign(new Error(`"db" in wisp-app.json names its seed file inside the app, like "seed.sql".`), { status: 400 });
    return { seed };
  }
  return { seed: exists('seed.sql') ? 'seed.sql' : '' };
}

export const allowedSql = (sql) => !DENY.test(sql);

export function createAppDb({ maxBytes = 10 * 1024 * 1024, timeoutMs = 5000 } = {}) {
  let child = null; // with .ready (whether node:sqlite is there) and .waiting (id -> { resolve, timer })
  let seq = 0;

  function start() {
    if (child) return child;
    child = fork(WORKER, [], { execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const me = child;
    me.waiting = new Map();
    me.ready = new Promise((resolve) => {
      me.once('message', (m) => resolve(!!m.ready));
      me.once('exit', () => resolve(false));
    });
    me.on('message', (m) => {
      const w = m.id && me.waiting.get(m.id);
      if (!w) return;
      me.waiting.delete(m.id);
      clearTimeout(w.timer);
      w.resolve(m);
    });
    me.on('exit', () => {
      if (child === me) child = null;
      for (const w of me.waiting.values()) {
        clearTimeout(w.timer);
        w.resolve({ error: 'The database stopped. Try again.', status: 503 });
      }
      me.waiting.clear();
    });
    me.unref();
    me.channel?.unref();
    return me;
  }

  async function ask(msg) {
    const me = start();
    if (!(await me.ready)) {
      if (child === me) child = null;
      return { error: 'App data needs Node.js 22.13 or newer on the computer running wisp (it uses the built-in SQLite).', status: 501 };
    }
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        me.waiting.delete(id);
        resolve({ error: `That query took over ${timeoutMs / 1000} s and was stopped.`, status: 503 });
        // The only way to stop a query in node:sqlite. The next query starts a new worker at once.
        if (child === me) child = null;
        me.kill('SIGKILL');
      }, timeoutMs);
      me.waiting.set(id, { resolve, timer });
      me.channel?.ref();
      me.send({ ...msg, id }, (err) => err && resolve({ error: err.message, status: 503 }));
    }).finally(() => {
      if (!me.waiting.size) me.channel?.unref();
    });
  }

  // POST /_wisp/db on the app's origin. file: its database; seed: SQL to make it with.
  async function handle(req, res, { file, seed = '' }) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return send(405, { error: 'POST { sql, params }' });
    // Only the app's own pages: JSON (so another site's form can't post it without asking), from its origin.
    if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return send(415, { error: 'Send JSON: { sql, params }.' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== req.headers.host) return send(403, { error: 'Only this app’s own pages can use its data.' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return send(err.status || 400, { error: err.status ? err.message : 'Bad JSON.' });
    }
    const sql = typeof body?.sql === 'string' ? body.sql : '';
    const params = Array.isArray(body?.params) ? body.params : [];
    if (!sql.trim()) return send(400, { error: 'No SQL.' });
    if (!allowedSql(sql)) return send(400, { error: 'Not in an app’s data: ATTACH, DETACH, PRAGMA, VACUUM and loading extensions.' });
    if (params.length > 999 || !params.every((p) => p === null || ['string', 'number', 'boolean'].includes(typeof p))) return send(400, { error: 'params: up to 999 strings, numbers, booleans or nulls.' });
    if (seed && !allowedSql(seed)) return send(400, { error: 'The app’s seed file uses ATTACH, PRAGMA or the like, which apps can’t.' });
    const r = await ask({ op: 'query', file, sql, params: params.map((p) => (typeof p === 'boolean' ? Number(p) : p)), seed, maxBytes });
    if (r.error) return send(r.status || 400, { error: /database or disk is full/i.test(r.error) ? `This app’s data is full (${Math.round(maxBytes / 1024 / 1024)} MB at most).` : r.error });
    const { id: _id, ...out } = r;
    send(200, out);
  }

  // Before its file goes (Reset data, an app removed): the worker lets go of it.
  async function release(file) {
    if (child) await ask({ op: 'close', file });
  }

  return {
    handle,
    release,
    close() {
      child?.kill();
      child = null;
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) reject(Object.assign(new Error('That query is too long (1 MB at most).'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
