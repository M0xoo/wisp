// The store's public shapes. Clock and Disposable match @wisp/kernel's contract structurally, so the
// store needs nothing from the kernel at runtime (the kernel builds on the store, not the reverse).

import type { DatabaseSync } from 'node:sqlite';
import type { PatchOp, Topic } from '@wisp/protocol';

export interface Clock {
  now(): number;
}

export interface Disposable {
  dispose(): void;
}

/** A plain JSON value, as rows hold and the change feed carries. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** One decoded row: column name → value (json columns parsed, bool columns as booleans). */
export type Row = Record<string, unknown>;

export type ColumnType = 'text' | 'int' | 'real' | 'bool' | 'blob';

export interface EntitySpec<R extends Row = Row> {
  /** the wire name ('session', 'turn', 'event'); unique per store */
  kind: string;
  /** the table the owner's migrations created (owner-prefixed for plugins: 'crew_member') */
  table: string;
  /** the primary key column; its value is the change row's `id` */
  key: keyof R & string;
  columns: { readonly [K in keyof R & string]: ColumnType };
  /** text columns that hold JSON */
  json?: readonly (keyof R & string)[];
  /** for an event log: the column whose value a batch of appends is grouped under ('session_id') */
  parent?: keyof R & string;
  /** the topics a change to this row is published on; the first is the change row's `topic` */
  topics(row: R): readonly Topic[];
}

/** A registered entity kind. `R` is phantom on the string API and real on the typed one. */
export interface EntityDef<R extends Row = Row> extends Readonly<EntitySpec<R>> {
  readonly __entity: true;
}

export type EntityRef<R extends Row = Row> = EntityDef<R> | string;

export type ChangeOp = 'upsert' | 'patch' | 'del' | 'append';

/**
 * One committed change. `patch` is what the sync layer puts on the wire: the full row for 'upsert'
 * (a row that did not exist), RFC 6902 ops for 'patch', null for 'del', the new rows for 'append'.
 * Listeners get the same objects the writer returned, uncopied: treat both as read-only.
 */
export interface ChangeRow {
  seq: number;
  topic: Topic;
  /** every topic, `topic` first */
  topics: readonly Topic[];
  entity: string;
  id: string;
  op: ChangeOp;
  patch: unknown;
  at: number;
}

export type WhereValue = string | number | boolean | null;
export type WhereCond =
  | WhereValue
  | readonly WhereValue[]
  | { gt?: WhereValue; gte?: WhereValue; lt?: WhereValue; lte?: WhereValue; ne?: WhereValue; like?: string };

export interface Query<R extends Row = Row> {
  /** a projection: only these columns are read and returned (the list needs a few, not all) */
  select?: readonly (keyof R & string)[];
  where?: { readonly [K in keyof R & string]?: WhereCond };
  order?: readonly (readonly [keyof R & string, 'asc' | 'desc'])[];
  limit?: number;
  offset?: number;
}

/** The one write path: every op writes its row and its change row in the same transaction. */
export interface Writer {
  /** Inserts, or updates the columns given (others keep their values). The key is required. */
  upsert<R extends Row>(kind: EntityRef<R>, row: Partial<R>): R;
  patch<R extends Row>(kind: EntityRef<R>, id: string | number, ops: readonly PatchOp[]): R;
  /** true when a row was there to delete */
  del(kind: EntityRef, id: string | number): boolean;
  /** inserts event-log rows; an INTEGER key left out is filled in. Returns the stored rows. */
  append<R extends Row>(kind: EntityRef<R>, rows: readonly R[]): R[];
}

export interface Migration {
  version: number;
  up: string | ((db: DatabaseSync) => void);
  /** for a table rebuild: foreign keys are off while it runs and checked before it commits */
  foreignKeysOff?: boolean;
}

export interface MutationResult<R> {
  result: R;
  /** the head of the change feed when the mutation committed: the ack's seq */
  seq: number;
  /** true when this (client, mid) ran before and the recorded result was returned */
  replayed: boolean;
}

export interface Retention {
  changeMs: number;
  changeRows: number;
  mutationMs: number;
}

export interface PruneResult {
  changes: number;
  mutations: number;
}

export interface SearchHit {
  kind: string;
  id: string;
  /** bm25: lower is better */
  score: number;
}
