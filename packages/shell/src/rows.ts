// The row shapes the shell itself reads, in one file so switching to @wisp/protocol's generated
// types is one edit. The truth today is plugins/runtime/host/src/schema.rs + rows.rs (the store row:
// a few columns, `summary` = runtime's camelCase Summary, `body` = the whole Session) and
// model.rs's `Activity` for an event's body.

export type SessionState = 'running' | 'review' | 'done' | 'error';

/** runtime's Summary (model.rs), plus fields plugins flatten in */
export interface Summary {
  readonly status: string;
  readonly turnCount: number;
  readonly queued: number;
  readonly preview: string;
  readonly live: string;
  readonly cwd: string;
  readonly model: string;
  readonly [field: string]: unknown;
}

/** A `session` row on the `list` topic. */
export interface SessionRow {
  readonly id: string;
  readonly parent_id?: string | null;
  readonly title: string;
  readonly state: SessionState;
  readonly agent: string;
  readonly archived: boolean;
  readonly unread: boolean;
  readonly created_at: number;
  readonly updated_at: number;
  readonly summary: Summary;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** One event of a session's activity: the items of the `event` list row (one per session). */
export interface EventRow {
  readonly session_id: string;
  readonly seq: number;
  readonly turn_id: string;
  readonly t: number;
  readonly kind: string;
  readonly body: { readonly kind: string; readonly text?: string; readonly label?: string; readonly [k: string]: unknown };
}

export const SESSION = 'session';
export const EVENT = 'event';
