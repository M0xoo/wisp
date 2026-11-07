// wisp.telemetry's tables. The install's random id (v1 config.telemetryId) and the two outboxes v1 kept
// as files: feedback that couldn't go out yet (feedback-outbox.json) and the stats queue saved at
// shutdown or on a crash (telemetry-pending.json), both sent on the next start.
import type { EntityDef, Store } from '@wisp/store';

export const OWNER = 'wisp.telemetry';

export interface StateRow {
  [k: string]: unknown;
  key: string;
  value: string;
}

export interface OutboxRow {
  [k: string]: unknown;
  id: string;
  /** 'feedback' (waits for the next feedback or start) or 'pending' (the stats queue at shutdown) */
  box: 'feedback' | 'pending';
  /** order within the box */
  n: number;
  event: unknown;
}

const MIGRATIONS = [
  {
    version: 1,
    up: `CREATE TABLE telemetry_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
         CREATE TABLE telemetry_outbox (id TEXT PRIMARY KEY, box TEXT NOT NULL, n INTEGER NOT NULL, event TEXT NOT NULL) STRICT;
         CREATE INDEX telemetry_outbox_box ON telemetry_outbox (box, n);`,
  },
] as const;

export interface Tables {
  state: EntityDef<StateRow>;
  outbox: EntityDef<OutboxRow>;
}

const made = new WeakMap<Store, Tables>();

/** Migrates and registers the tables, once per store (at setup, where sync work is allowed). */
export function tables(store: Store): Tables {
  const had = made.get(store);
  if (had) return had;
  store.migrate(OWNER, MIGRATIONS);
  const t: Tables = {
    state: store.defineEntity<StateRow>({ kind: 'telemetry.state', table: 'telemetry_state', key: 'key', columns: { key: 'text', value: 'text' }, topics: () => ['plugin:wisp.telemetry:state'] }),
    outbox: store.defineEntity<OutboxRow>({
      kind: 'telemetry.outbox',
      table: 'telemetry_outbox',
      key: 'id',
      columns: { id: 'text', box: 'text', n: 'int', event: 'text' },
      json: ['event'],
      topics: () => ['plugin:wisp.telemetry:outbox'],
    }),
  };
  made.set(store, t);
  return t;
}
