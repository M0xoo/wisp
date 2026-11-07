// The row shapes the shell itself reads, in one file so switching to @wisp/protocol's generated
// types (crates/wisp-protocol → packages/protocol/src/generated) is one edit. Until then the
// truth is plugins/runtime/api/src/model.rs `Summary` (camelCase on the wire).

export type SessionState = 'running' | 'review' | 'done' | 'error';

/** A `session` row on the `list` topic (runtime's Summary, plus fields plugins flatten in). */
export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly model: string;
  readonly state: SessionState;
  readonly status: string;
  readonly unread: boolean;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
  readonly preview: string;
  readonly live: string;
  readonly cwd: string;
  readonly [field: string]: unknown;
}

/** One event of a session's activity (`event` list row, one per session). */
export interface EventRow {
  readonly seq: number;
  readonly session_id: string;
  readonly turn_id?: string;
  readonly kind: string;
  readonly text?: string;
  readonly label?: string;
  readonly [field: string]: unknown;
}

export const SESSION = 'session';
export const EVENT = 'event';
