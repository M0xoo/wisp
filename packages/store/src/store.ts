// @wisp/store: one SQLite file (node:sqlite, WAL) holding every row wisp keeps, plus the change feed
// that sync, history and plugin subscriptions all read (ADR-0004, plan §4.1). Writes happen only in
// store.tx(); listeners hear about a transaction after it commits, never about one that rolled back.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue, StatementSync } from 'node:sqlite';
import type { Topic } from '@wisp/protocol';
import { Blobs } from './blob.ts';
import { Kind, compileQuery, defineEntity } from './entity.ts';
import { StoreError, invalid } from './errors.ts';
import { type MigrateReport, runMigrations, schemaVersion } from './migrate.ts';
import { KERNEL_MIGRATIONS, KERNEL_OWNER } from './schema.ts';
import { Search } from './search.ts';
import { BUILTIN_ENTITIES } from './builtins.ts';
import { readChanges } from './changes.ts';
import { type WriteCtx, makeWriter, readRow } from './writer.ts';
import type { ChangeRow, Clock, Disposable, EntityDef, EntityRef, EntitySpec, Migration, MutationResult, PruneResult, Query, Retention, Row, SearchHit, Writer } from './types.ts';

export interface StoreOptions {
  /** a file path, or ':memory:' (tests): no WAL, no snapshots, every blob inline */
  path: string;
  /** where backups/ and blobs/ go; defaults to the database file's folder */
  home?: string;
  clock?: Clock;
  /** makes a fresh epoch value (on a new database and on rotateEpoch); tests inject a fixed one */
  epoch?: () => string;
  retention?: Partial<Retention>;
  /** a throwing onCommit listener is reported here, and the others still run */
  onListenerError?: (err: unknown) => void;
}

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION: Retention = { changeMs: 7 * DAY, changeRows: 1_000_000, mutationMs: DAY };
const STORE_META = /^(epoch|schema:|search:)/;
const STMT_CACHE_MAX = 1000;

export function openStore(opts: StoreOptions): Store {
  return new Store(opts);
}

export class Store {
  readonly home: string | undefined;
  readonly blobs: Blobs;
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #makeEpoch: () => string;
  readonly #retention: Retention;
  readonly #onListenerError: (err: unknown) => void;
  readonly #stmts = new Map<string, StatementSync>();
  readonly #kinds = new Map<string, Kind>();
  readonly #listeners = new Set<(changes: readonly ChangeRow[]) => void>();
  readonly #epochListeners = new Set<(epoch: string) => void>();
  readonly #search: Search;
  readonly #writer: Writer;
  #depth = 0;
  #arrays = true;
  #doomed: unknown = undefined;
  #pending: ChangeRow[] = [];
  #epoch = '';

  constructor(opts: StoreOptions) {
    const memory = opts.path === ':memory:';
    this.home = opts.home ?? (memory ? undefined : path.dirname(path.resolve(opts.path)));
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#makeEpoch = opts.epoch ?? (() => randomUUID());
    this.#retention = { ...DEFAULT_RETENTION, ...opts.retention };
    this.#onListenerError = opts.onListenerError ?? ((err) => console.error('[store] onCommit listener threw', err));
    this.#db = new DatabaseSync(opts.path);
    try {
      if (!memory) this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY');
      this.migrate(KERNEL_OWNER, KERNEL_MIGRATIONS);
    } catch (err) {
      this.#db.close();
      throw err;
    }
    const stmt = (sql: string): StatementSync => this.#stmt(sql);
    this.blobs = new Blobs({ stmt, tx: (fn) => this.tx(() => fn()), home: this.home, now: () => this.#clock.now() });
    this.#search = new Search(this.#db, stmt);
    this.#writer = makeWriter(this.#writeCtx());
    for (const def of BUILTIN_ENTITIES) this.register(def);
    this.#epoch = this.getMeta('epoch') ?? this.#setEpoch(this.#makeEpoch());
  }

  get epoch(): string {
    return this.#epoch;
  }

  // ---------- schema ----------

  migrate(owner: string, migrations: readonly Migration[]): MigrateReport {
    const report = runMigrations({ db: this.#db, home: this.home, now: this.#clock.now() }, owner, migrations);
    if (report.to !== report.from) this.#stmts.clear(); // tables changed under cached statements
    return report;
  }

  schemaVersion(owner: string): number {
    return schemaVersion(this.#db, owner);
  }

  /** Registers an owner's entity kind and returns it (typed, for the typed writer API). */
  defineEntity<R extends Row = Row>(spec: EntitySpec<R>): EntityDef<R> {
    const def = defineEntity(spec);
    this.register(def);
    return def;
  }

  register(def: EntityDef): void {
    const had = this.#kinds.get(def.kind);
    if (had && had.def !== def) throw invalid(`entity kind ${def.kind} is already registered`);
    this.#kinds.set(def.kind, new Kind(def));
  }

  defineSearch(kind: EntityRef, columns: readonly string[]): void {
    this.tx(() => this.#search.define(this.#kind(kind), columns));
  }

  // ---------- writes ----------

  /**
   * Runs `fn` in one transaction. A nested call joins the outer one; a throw anywhere rolls back
   * everything, even when an outer caller catches it. `fn` must be synchronous: a transaction cannot
   * stay open across an await.
   */
  tx<T>(fn: (w: Writer) => T): T {
    if (this.#depth > 0) return this.#nested(fn);
    this.#db.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    this.#doomed = undefined;
    this.#pending = [];
    let result: T;
    try {
      result = fn(this.#writer);
      if (isThenable(result)) throw invalid('store.tx(fn): fn returned a promise; a transaction must finish synchronously');
      if (this.#doomed !== undefined) throw new StoreError('internal', 'a nested store.tx threw, so the whole transaction rolled back', false);
      this.#db.exec('COMMIT');
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      this.#pending = [];
      throw err;
    } finally {
      this.#depth = 0;
    }
    const committed = this.#pending;
    this.#pending = [];
    if (committed.length > 0) this.#publish(committed);
    return result;
  }

  #nested<T>(fn: (w: Writer) => T): T {
    this.#depth++;
    try {
      const result = fn(this.#writer);
      if (isThenable(result)) throw invalid('store.tx(fn): fn returned a promise; a transaction must finish synchronously');
      return result;
    } catch (err) {
      this.#doomed = err;
      throw err;
    } finally {
      this.#depth--;
    }
  }

  /**
   * Runs a client's mutation once (plan §4.5). The (client, mid) record commits with its effects,
   * so a retry over a flaky tunnel gets the first result back instead of running it again.
   */
  recordMutation<R>(clientId: string, mid: string, fn: (w: Writer) => R): MutationResult<R> {
    return this.tx((w) => {
      const had = this.#stmt('SELECT result, seq FROM mutation WHERE client_id = ? AND mid = ?').get(clientId, mid);
      if (had) {
        const raw = had['result'];
        return { result: (raw === null ? undefined : JSON.parse(String(raw))) as R, seq: Number(had['seq']), replayed: true };
      }
      const result = fn(w);
      const seq = this.headSeq();
      const stored = result === undefined ? null : JSON.stringify(result);
      this.#stmt('INSERT INTO mutation (client_id, mid, status, result, seq, at) VALUES (?, ?, ?, ?, ?, ?)').run(clientId, mid, 'ok', stored, seq, this.#clock.now());
      return { result, seq, replayed: false };
    });
  }

  onCommit(fn: (changes: readonly ChangeRow[]) => void): Disposable {
    this.#listeners.add(fn);
    return { dispose: () => void this.#listeners.delete(fn) };
  }

  onEpoch(fn: (epoch: string) => void): Disposable {
    this.#epochListeners.add(fn);
    return { dispose: () => void this.#epochListeners.delete(fn) };
  }

  #publish(changes: readonly ChangeRow[]): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(changes);
      } catch (err) {
        this.#onListenerError(err);
      }
    }
  }

  // ---------- reads ----------

  get<R extends Row = Row>(kind: EntityRef<R>, id: string | number): R | undefined {
    return readRow({ stmt: (s) => this.#stmt(s) }, this.#kind(kind as EntityRef), id) as R | undefined;
  }

  /** Rows of a kind; with `select`, only those columns (typed as such). */
  query<R extends Row = Row, C extends keyof R & string = keyof R & string>(kind: EntityRef<R>, q: Query<NoInfer<R>> & { select?: readonly C[] } = {}): Pick<R, C>[] {
    const k = this.#kind(kind as EntityRef);
    const { sql, params } = compileQuery(k, q as Query);
    const only = q.select && q.select.length > 0 ? q.select : undefined;
    const arrays = this.#arrayStmt(sql);
    if (arrays) return (arrays.all(...params) as unknown as SQLOutputValue[][]).map((vals) => k.decodeArray(vals, only) as Pick<R, C>);
    return this.#stmt(sql).all(...params).map((raw) => k.decode(raw, only) as Pick<R, C>);
  }

  count<R extends Row = Row>(kind: EntityRef<R>, where: Query<NoInfer<R>>['where'] = {}): number {
    const k = this.#kind(kind as EntityRef);
    const { sql, params } = compileQuery(k, { where } as Query);
    const countSql = sql.replace(/^SELECT .*? FROM /, 'SELECT count(*) AS n FROM ');
    return Number(this.#stmt(countSql).get(...params)?.['n'] ?? 0);
  }

  /** Committed changes after `seq`, oldest first; only those on `topics` when given. */
  changesSince(seq: number, topics?: readonly Topic[], limit = 1000): ChangeRow[] {
    return readChanges((s) => this.#stmt(s), seq, topics, limit);
  }

  /** The newest seq ever written (0 for none). Survives retention: seqs are never reused. */
  headSeq(): number {
    return Number(this.#stmt("SELECT seq FROM sqlite_sequence WHERE name = 'change'").get()?.['seq'] ?? 0);
  }

  /** The oldest seq still kept, or head + 1 when retention left none. */
  oldestSeq(): number {
    const min = this.#stmt('SELECT min(seq) AS s FROM change').get()?.['s'];
    return min === null || min === undefined ? this.headSeq() + 1 : Number(min);
  }

  /** Whether a client that has seen everything up to `cursor` can resume from the feed. */
  canResume(cursor: number): boolean {
    return Number.isInteger(cursor) && cursor <= this.headSeq() && cursor >= this.oldestSeq() - 1;
  }

  search(text: string, opts: { kinds?: readonly string[]; limit?: number } = {}): SearchHit[] {
    return this.#search.search(text, opts);
  }

  // ---------- meta, retention, epoch ----------

  getMeta(key: string): string | undefined {
    const v = this.#stmt('SELECT value FROM meta WHERE key = ?').get(key)?.['value'];
    return v === undefined ? undefined : String(v);
  }

  /** Owners' bookkeeping (import progress, …). Keys the store manages itself are refused. */
  setMeta(key: string, value: string | undefined): void {
    if (STORE_META.test(key)) throw invalid(`meta key ${key} belongs to the store`);
    this.#writeMeta(key, value);
  }

  #writeMeta(key: string, value: string | undefined): void {
    this.tx(() => {
      if (value === undefined) this.#stmt('DELETE FROM meta WHERE key = ?').run(key);
      else this.#stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    });
  }

  /** A fresh epoch, after a restore or an import: every client's cursor from before is distrusted. */
  rotateEpoch(): string {
    const epoch = this.#setEpoch(this.#makeEpoch());
    for (const fn of [...this.#epochListeners]) {
      try {
        fn(epoch);
      } catch (err) {
        this.#onListenerError(err);
      }
    }
    return epoch;
  }

  #setEpoch(epoch: string): string {
    this.#writeMeta('epoch', epoch);
    this.#epoch = epoch;
    return epoch;
  }

  /** Change rows: 7 days or 1M rows, whichever keeps fewer. Mutation records: 24 h. */
  prune(now = this.#clock.now()): PruneResult {
    const r = this.#retention;
    return this.tx(() => {
      const byCount = this.#stmt('DELETE FROM change WHERE seq <= ?').run(this.headSeq() - r.changeRows).changes;
      const byAge = this.#stmt('DELETE FROM change WHERE at < ?').run(now - r.changeMs).changes;
      const mutations = this.#stmt('DELETE FROM mutation WHERE at < ?').run(now - r.mutationMs).changes;
      return { changes: Number(byCount) + Number(byAge), mutations: Number(mutations) };
    });
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---------- internals ----------

  #stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      if (this.#stmts.size >= STMT_CACHE_MAX) this.#stmts.clear(); // shapes are bounded; this is a backstop
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  /**
   * The statement in array mode, when this node:sqlite has it (22.16+ / 24+): node builds an object
   * per row slowly, and a 4,000-row list spends most of its time there. Undefined on older runtimes.
   */
  #arrayStmt(sql: string): StatementSync | undefined {
    if (!this.#arrays) return undefined;
    const key = `arrays\0${sql}`;
    let s = this.#stmts.get(key);
    if (!s) {
      s = this.#db.prepare(sql);
      if (typeof (s as Partial<Pick<StatementSync, 'setReturnArrays'>>).setReturnArrays !== 'function') {
        this.#arrays = false;
        return undefined;
      }
      s.setReturnArrays(true);
      this.#stmts.set(key, s);
    }
    return s;
  }

  #kind(ref: EntityRef): Kind {
    const name = typeof ref === 'string' ? ref : ref.kind;
    const k = this.#kinds.get(name);
    if (!k) throw invalid(`unknown entity kind ${name}: its owner must define it first`);
    return k;
  }

  #writeCtx(): WriteCtx {
    const self = this;
    return {
      stmt: (sql) => self.#stmt(sql),
      kind(ref) {
        // a writer kept past its transaction would write outside the one write path
        if (self.#depth === 0) throw invalid('this writer belongs to a transaction that has ended');
        return self.#kind(ref);
      },
      now: () => self.#clock.now(),
      get pending() {
        return self.#pending;
      },
      reindex(kind, id, row) {
        if (self.#search.has(kind.kind)) self.#search.index(kind, id, row);
      },
    };
  }
}

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}
