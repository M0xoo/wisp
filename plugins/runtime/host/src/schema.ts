// wisp.runtime's tables (plan §4.1) and their entity kinds. Forward-only: never edit a shipped
// migration, add the next one (the add-migration skill).
//
//   rt_session  one row per task: the fields the runner and the list query read are columns, the
//               rest of what the runtime owns is `data` (JSON), other plugins' slots are `ext`.
//   rt_turn     one row per turn. Its activity is not in it: that is the event log.
//   rt_event    the append-only activity log (one row per step, and `set` rows that update a step,
//               such as a call's output arriving). (session_id, seq) is unique and dense.
//   rt_summary  the list row, a projection kept in the same transaction as what it summarises, so
//               the list is one indexed read and sync sends a row's changed fields only.
//
// A session's turns, events and summary go with it (ON DELETE CASCADE): its `del` change on
// session:<id> and list tells every client to drop them, without one change row per event.

import type { EntityDef, Migration, Row, Store } from '@wisp/store';

export const OWNER = 'wisp.runtime';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE rt_session (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        mode TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        unread INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        queue TEXT NOT NULL,
        data TEXT NOT NULL,
        ext TEXT NOT NULL
      ) STRICT;
      CREATE INDEX rt_session_parent ON rt_session (parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX rt_session_state ON rt_session (state) WHERE state IN ('running', 'waiting');

      CREATE TABLE rt_turn (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES rt_session (id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        presentation TEXT,
        stats TEXT,
        raw TEXT,
        answer TEXT,
        data TEXT NOT NULL,
        ext TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX rt_turn_idx ON rt_turn (session_id, idx);

      CREATE TABLE rt_event (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES rt_session (id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        t INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        v INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX rt_event_seq ON rt_event (session_id, seq);
      CREATE INDEX rt_event_turn ON rt_event (turn_id, seq);

      CREATE TABLE rt_summary (
        id TEXT PRIMARY KEY REFERENCES rt_session (id) ON DELETE CASCADE,
        archived INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        parent_id TEXT,
        row TEXT NOT NULL
      ) STRICT;
      CREATE INDEX rt_summary_list ON rt_summary (archived, updated_at DESC);
    `,
  },
];

export interface SessionRow extends Row {
  id: string;
  title: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
  cwd: string;
  state: string;
  unread: boolean;
  archived: boolean;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  queue: unknown;
  data: unknown;
  ext: unknown;
}

export interface TurnRow extends Row {
  id: string;
  session_id: string;
  idx: number;
  prompt: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  presentation: unknown;
  stats: unknown;
  raw: string | null;
  /** the words of its answer (v1 search's pieces), for full-text search */
  answer: string | null;
  data: unknown;
  ext: unknown;
}

export interface EventRow extends Row {
  id?: number;
  session_id: string;
  turn_id: string;
  seq: number;
  t: number;
  /** 'step': body is a v1 activity step; 'set': body is { ref: seq, …fields } laid over that step */
  kind: 'step' | 'set';
  body: unknown;
  /** body version: a reader upcasts older shapes, history is never rewritten (plan §4.2) */
  v: number;
}

export interface SummaryRow extends Row {
  id: string;
  archived: boolean;
  updated_at: number;
  parent_id: string | null;
  row: unknown;
}

export interface Entities {
  session: EntityDef<SessionRow>;
  turn: EntityDef<TurnRow>;
  event: EntityDef<EventRow>;
  summary: EntityDef<SummaryRow>;
}

export const EVENT_V = 1;

export function defineEntities(store: Store): Entities {
  store.migrate(OWNER, MIGRATIONS);
  const session = store.defineEntity<SessionRow>({
    kind: 'session',
    table: 'rt_session',
    key: 'id',
    columns: { id: 'text', title: 'text', agent: 'text', model: 'text', effort: 'text', mode: 'text', cwd: 'text', state: 'text', unread: 'bool', archived: 'bool', parent_id: 'text', created_at: 'int', updated_at: 'int', queue: 'text', data: 'text', ext: 'text' },
    json: ['queue', 'data', 'ext'],
    topics: (r) => [`session:${r.id}`],
  });
  const turn = store.defineEntity<TurnRow>({
    kind: 'turn',
    table: 'rt_turn',
    key: 'id',
    columns: { id: 'text', session_id: 'text', idx: 'int', prompt: 'text', status: 'text', started_at: 'int', ended_at: 'int', presentation: 'text', stats: 'text', raw: 'text', answer: 'text', data: 'text', ext: 'text' },
    json: ['presentation', 'stats', 'data', 'ext'],
    topics: (r) => [`session:${r.session_id}`],
  });
  const event = store.defineEntity<EventRow>({
    kind: 'event',
    table: 'rt_event',
    key: 'id',
    parent: 'session_id',
    columns: { id: 'int', session_id: 'text', turn_id: 'text', seq: 'int', t: 'int', kind: 'text', body: 'text', v: 'int' },
    json: ['body'],
    topics: (r) => [`session:${r.session_id}`],
  });
  const summary = store.defineEntity<SummaryRow>({
    kind: 'summary',
    table: 'rt_summary',
    key: 'id',
    columns: { id: 'text', archived: 'bool', updated_at: 'int', parent_id: 'text', row: 'text' },
    json: ['row'],
    topics: () => ['list'],
  });
  // Prompts and answers: written when a turn starts and when it ends, so the index barely moves
  // while a task streams. Titles are searched with LIKE on rt_session (search.ts): a title row
  // changes on every touch, and re-indexing it each time would be most of a stream's writes.
  store.defineSearch(turn, ['prompt', 'answer']);
  return { session, turn, event, summary };
}
