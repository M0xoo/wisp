// A small owner for the tests: sessions (plain rows) and their events (an append-only log), with
// the migrations a plugin would ship.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/index.ts';
import type { EntityDef, Migration, Store, StoreOptions } from '../src/index.ts';

export interface SessionRow {
  [k: string]: unknown;
  id: string;
  title: string | null;
  state: string | null;
  archived: boolean | null;
  updated_at: number | null;
  extra: unknown;
}

export interface EventRow {
  [k: string]: unknown;
  id?: number;
  session_id: string;
  seq: number;
  kind: string;
  body: unknown;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE t_session (id TEXT PRIMARY KEY, title TEXT, state TEXT, archived INTEGER, updated_at INTEGER, extra TEXT) STRICT;
         CREATE INDEX t_session_list ON t_session (archived, updated_at);
         CREATE TABLE t_event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES t_session (id), seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT) STRICT;
         CREATE UNIQUE INDEX t_event_seq ON t_event (session_id, seq);`,
  },
];

export interface Fixture {
  store: Store;
  session: EntityDef<SessionRow>;
  event: EntityDef<EventRow>;
  clock: { t: number; now(): number };
  home: string | undefined;
}

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-store-'));
}

export function open(opts: Partial<StoreOptions> & { disk?: boolean } = {}): Fixture {
  const clock = { t: 1_000_000, now: () => clock.t };
  const home = opts.disk ? (opts.home ?? tmpHome()) : opts.home;
  const store = openStore({ path: opts.disk ? path.join(home as string, 'wisp.db') : ':memory:', clock, epoch: () => 'epoch-1', ...(home ? { home } : {}), ...opts });
  store.migrate('test', MIGRATIONS);
  return { store, clock, home, ...define(store) };
}

export function define(store: Store): { session: EntityDef<SessionRow>; event: EntityDef<EventRow> } {
  const session = store.defineEntity<SessionRow>({
    kind: 'session',
    table: 't_session',
    key: 'id',
    columns: { id: 'text', title: 'text', state: 'text', archived: 'bool', updated_at: 'int', extra: 'text' },
    json: ['extra'],
    topics: (r) => ['list', `session:${r.id}`],
  });
  const event = store.defineEntity<EventRow>({
    kind: 'event',
    table: 't_event',
    key: 'id',
    parent: 'session_id',
    columns: { id: 'int', session_id: 'text', seq: 'int', kind: 'text', body: 'text' },
    json: ['body'],
    topics: (r) => [`session:${r.session_id}`],
  });
  return { session, event };
}

export function sessionRow(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return { id, title: `task ${id}`, state: 'idle', archived: false, updated_at: 1, extra: null, ...over };
}
