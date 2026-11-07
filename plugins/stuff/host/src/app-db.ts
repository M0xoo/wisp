// An app's own SQLite database (v1 server/app-db.js), for demo apps that keep data (a todo list, a
// form's entries, a game's scores). Off unless its wisp-app.json says "db": true (or names its seed:
// "db": "seed.sql", run once when the database is made). The app reaches it on its own origin:
//
//   import { sql } from '/_wisp/db.js';
//   await sql('INSERT INTO todos (text) VALUES (?)', text);    // → { changes, lastId }
//   const rows = await sql('SELECT * FROM todos');            // → [{ id, text }, …]
//
// Queries run in a child process (serve/db-worker.ts, through the proc service) that's killed when
// one runs too long: node:sqlite can't be interrupted any other way.

import { fileURLToPath } from 'node:url';
import type { Child, ProcService } from '@wisp/kernel';
import { jsonLines, line } from './lines.ts';

const WORKER = fileURLToPath(new URL('./serve/db-worker.ts', import.meta.url));
export const DB_BODY_LIMIT = 1024 * 1024;
// For the worker to open the file, before the query's own limit starts: a lock left by a stopped
// worker or a slow disk isn't the query being slow, but a hung file still ends.
const OPEN_MS = 15_000;
// Nothing that reaches past the app's own file (ATTACH writes anywhere), loads code, or changes the
// limits set on it. Whole words, so a string that merely says them is refused too: rare.
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

export const allowedSql = (sql: string): boolean => !DENY.test(sql);

export type Answer = Record<string, unknown> & { error?: string; status?: number };

export interface AppDbOptions {
  proc: ProcService;
  maxBytes?: number;
  timeoutMs?: number;
  /** the scope's timer (fires once; a stale one does nothing) */
  timeout: (ms: number, fn: () => void) => void;
}

interface Waiting {
  resolve: (a: Answer) => void;
  /** bumped on every arm: an older timer finds it moved and does nothing */
  gen: number;
  limit(): void;
}

interface Worker {
  child: Child;
  ready: Promise<boolean>;
  exited: Promise<unknown>;
  waiting: Map<number, Waiting>;
}

export interface AppDb {
  query(msg: { file: string; sql: string; params: (string | number | null)[]; seed: string }): Promise<Answer>;
  /** before its file goes (Reset data, an app removed): the worker lets go of it */
  release(file: string): Promise<void>;
  close(): void;
  readonly maxBytes: number;
}

export const createAppDb = (o: AppDbOptions): AppDb => new AppDbClient(o);

class AppDbClient implements AppDb {
  readonly maxBytes: number;
  readonly #o: AppDbOptions;
  readonly #timeoutMs: number;
  #worker: Worker | null = null;
  #seq = 0;
  // A worker that was killed but hasn't exited yet. The next one waits for it: on Windows the kill is
  // asynchronous and the dead worker's locks on the file linger until it's gone.
  #dying: Promise<void> | null = null;

  constructor(o: AppDbOptions) {
    this.#o = o;
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.#timeoutMs = o.timeoutMs ?? 5000;
  }

  query(m: { file: string; sql: string; params: (string | number | null)[]; seed: string }): Promise<Answer> {
    return this.#ask({ op: 'query', ...m, maxBytes: this.maxBytes });
  }

  async release(file: string): Promise<void> {
    if (this.#worker) await this.#ask({ op: 'close', file });
  }

  close(): void {
    this.#worker?.child.kill('SIGTERM');
    this.#worker = null;
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const child = this.#o.proc.spawn(process.execPath, ['--no-warnings', WORKER], { stdin: 'pipe' });
    let ready: (ok: boolean) => void = () => {};
    const me: Worker = { child, ready: new Promise<boolean>((r) => (ready = r)), exited: child.exited, waiting: new Map() };
    child.onStdout(
      jsonLines((m) => {
        if ('ready' in m) return ready(!!m['ready']);
        const id = typeof m['id'] === 'number' ? m['id'] : -1;
        const w = me.waiting.get(id);
        if (!w) return;
        if (m['started']) return w.limit();
        me.waiting.delete(id);
        w.resolve(m);
      }),
    );
    void child.exited.then(() => {
      ready(false);
      if (this.#worker === me) this.#worker = null;
      for (const w of me.waiting.values()) w.resolve({ error: 'The database stopped. Try again.', status: 503 });
      me.waiting.clear();
    });
    this.#worker = me;
    return me;
  }

  #kill(me: Worker): void {
    if (this.#worker === me) this.#worker = null; // the next query starts a new worker at once
    // Never wait forever on it: a worker that won't die is still replaced after a while.
    const gone: Promise<void> = (this.#dying = Promise.race([me.exited, new Promise<void>((r) => this.#o.timeout(5000, r))]).then(() => {
      if (this.#dying === gone) this.#dying = null;
    }));
    me.child.kill('SIGKILL');
  }

  async #ask(msg: Record<string, unknown>): Promise<Answer> {
    if (this.#dying) await this.#dying;
    const me = this.#start();
    if (!(await me.ready)) {
      if (this.#worker === me) this.#worker = null;
      return { error: 'App data needs Node.js 22.13 or newer on the computer running wisp (it uses the built-in SQLite).', status: 501 };
    }
    const id = ++this.#seq;
    return new Promise<Answer>((resolve) => {
      const w: Waiting = { resolve, gen: 0, limit: () => arm(this.#timeoutMs, `That query took over ${this.#timeoutMs / 1000} s and was stopped.`) };
      // Timed from when the worker says it started (its file is open), not from sending, and judged
      // only after the answers already in the pipe are read (setImmediate runs after them): a busy wisp
      // that reads its messages late would otherwise stop a query that took a millisecond.
      const arm = (ms: number, error: string): void => {
        const gen = ++w.gen;
        this.#o.timeout(ms, () =>
          setImmediate(() => {
            if (w.gen !== gen || me.waiting.get(id) !== w) return;
            me.waiting.delete(id);
            resolve({ error, status: 503 });
            this.#kill(me);
          }),
        );
      };
      me.waiting.set(id, w);
      arm(OPEN_MS, `This app’s data took over ${OPEN_MS / 1000} s to open.`);
      me.child.write(line({ ...msg, id }));
    });
  }
}

/** The request an app's page sent to /_wisp/db, as its front passes it on. */
export interface DbRequest {
  method: string;
  contentType: string;
  origin: string | undefined;
  host: string;
  body: string;
  tooBig?: boolean;
}

/** POST /_wisp/db on the app's origin: checked, then run in its file (seed: SQL to make it with). */
export async function dbAnswer(db: AppDb, req: DbRequest, file: string, seed = ''): Promise<{ status: number; json: Answer }> {
  const send = (status: number, json: Answer): { status: number; json: Answer } => ({ status, json });
  if (req.method !== 'POST') return send(405, { error: 'POST { sql, params }' });
  // Only the app's own pages: JSON (so another site's form can't post it without asking), from its origin.
  if (!/^application\/json/i.test(req.contentType)) return send(415, { error: 'Send JSON: { sql, params }.' });
  if (req.origin && req.origin !== 'null') {
    let host = '';
    try {
      host = new URL(req.origin).host;
    } catch {
      // not a URL: no host, refused below
    }
    if (host !== req.host) return send(403, { error: 'Only this app’s own pages can use its data.' });
  }
  if (req.tooBig) return send(413, { error: 'That query is too long (1 MB at most).' });
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return send(400, { error: 'Bad JSON.' });
  }
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const sql = typeof b['sql'] === 'string' ? b['sql'] : '';
  const params: unknown[] = Array.isArray(b['params']) ? b['params'] : [];
  if (!sql.trim()) return send(400, { error: 'No SQL.' });
  if (!allowedSql(sql)) return send(400, { error: 'Not in an app’s data: ATTACH, DETACH, PRAGMA, VACUUM and loading extensions.' });
  if (params.length > 999 || !params.every((p) => p === null || ['string', 'number', 'boolean'].includes(typeof p))) return send(400, { error: 'params: up to 999 strings, numbers, booleans or nulls.' });
  if (seed && !allowedSql(seed)) return send(400, { error: 'The app’s seed file uses ATTACH, PRAGMA or the like, which apps can’t.' });
  const r = await db.query({ file, sql, params: params.map((p) => (typeof p === 'boolean' ? Number(p) : (p as string | number | null))), seed });
  if (r.error) return send(r.status || 400, { error: /database or disk is full/i.test(r.error) ? `This app’s data is full (${Math.round(db.maxBytes / 1024 / 1024)} MB at most).` : r.error });
  const { id: _id, ...out } = r;
  return send(200, out);
}
