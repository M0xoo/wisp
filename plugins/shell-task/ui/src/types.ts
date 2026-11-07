// Every row shape the task view reads, in one file (docs/v2-ui-brief.md). When
// packages/protocol/src/generated/ exports the Rust rows (ts-rs, plugins/runtime/api/src/model.rs),
// this file re-exports them and nothing else changes. Until then the truth is v1's `summarize()`
// (server/runner.js:250), its full session JSON (`GET /api/sessions/:id`) and runtime's model.rs.
//
// Where the rows live (entity kinds, keyed `<peer>:<id>` in @wisp/client's store):
//   session   the task: runtime's Summary plus the v1 fields plugins add (`summary@1`), topic `list`
//             and `session:<id>`
//   turn      one turn of a task (model.rs Turn, camelCase), topic `session:<id>`
//   event     a task's activity log: ONE list row per session (id = the session id) holding
//             EventRow[], oldest first, paged backwards by client.transcripts (`window`)
//   change    the side panel's Changes for a task: one row per session (id = the session id), topic
//             `plugin:wisp.git:<session id>`
//   pr        the PR panel's detail for a task: one row per session, topic `plugin:wisp.ship:<id>`
//   watch     the watch page a task's agent keeps up to date: one row per session,
//             topic `plugin:wisp.watch:<id>`
//   comment   comments on a task's diffs and answers: rows keyed by comment id, topic `session:<id>`

import type { DeepReadonly, EntityKey } from '@wisp/client';

export type SessionState = 'running' | 'waiting' | 'review' | 'done' | 'error';
export type TurnStatus = 'running' | 'done' | 'error' | 'held' | 'stopped';
export type Mode = 'plan' | 'edits' | 'auto';
export type ToolKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'tool' | 'wait' | 'ask' | 'answer' | 'background';

export interface PrRef {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft?: boolean;
  review?: string;
  checks?: 'pass' | 'fail' | 'pending' | string;
  conflict?: boolean;
}

/** What holds a turn before it starts (server/guard.js, harness-watch.js, project-trust.js). */
export interface Held {
  kind: string; // 'limit' | 'harness' | 'project' | 'load' | …
  label?: string;
  used?: number;
  to?: number;
  line?: string;
  resetsAt?: number;
  until?: number;
  waiting?: boolean;
  harness?: { name?: string; was?: string; now?: string; path?: string };
  project?: { count: number; changed?: boolean; setup?: unknown; items?: { kind: string; name: string; detail?: string }[] };
}

/** A question the agent is waiting on (ask_user), or a live approval (Edits mode). */
export interface Ask {
  id?: string;
  question: string;
  options?: string[];
  /** several options may be picked */
  multi?: boolean;
  /** a live approval: Allow / Deny, with what it wants to do */
  permission?: { tool: string; detail?: string; rule?: string };
  /** a clash with another task over the same files */
  clash?: { id: string; title: string; files: string[] };
  /** asked by a delegate or crew member on the lead's behalf */
  from?: { id: string; title: string; label?: string };
  at?: number;
}

export interface Watch {
  seq: number;
  title?: string;
  closed?: boolean;
  url?: string;
}

/** The open task (v1 summary + the fields its full JSON adds that the task view reads). */
export interface Task {
  id: string;
  title: string;
  agent: string;
  model?: string;
  effort?: string;
  account?: string;
  mode: Mode;
  cwd?: string;
  project?: string;
  projectId?: string | null;
  color?: string;
  state: SessionState;
  status?: string;
  halt?: 'limit' | 'signedOut' | 'refused' | 'failed';
  unread?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  turnCount?: number;
  queued?: number;
  queueHeld?: boolean;
  queue?: { id: string; text: string; at: number; by?: string }[];
  preview?: string;
  live?: string;
  held?: Held;
  ask?: Ask;
  asks?: boolean;
  question?: string;
  options?: string[];
  approval?: boolean;
  branch?: string;
  foreign?: string;
  keepWorktree?: boolean;
  worktree?: { branch?: string; path?: string; foreign?: string };
  toShip?: { dirty?: number; ahead?: number; unpushed?: number } | null;
  shipping?: { step: string; update?: string } | null;
  pr?: PrRef | null;
  prs?: { repo: string; pr: PrRef }[];
  conflictFix?: { step: string; why?: string } | null;
  review?: { status: string; by?: string; findings?: number; why?: string } | null;
  watch?: Watch;
  term?: boolean;
  tags?: string[];
  parentId?: string;
  sideOf?: { id: string; title: string };
  goal?: { status: string; text?: string; round?: number };
  overlaps?: { id: string; title: string; files: string[] }[];
  forLater?: { at: number; by?: string };
  origin?: { kind: string; id?: string; name?: string } | null;
  team?: { name: string; agent: string; busy?: boolean; id?: string }[];
  costUsd?: number;
  /** the folders the task may touch besides cwd */
  dirs?: string[];
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface TurnStats {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  ms?: number;
  models?: Record<string, unknown>;
}

export interface Presentation {
  blocks: unknown[];
  v: number;
  /** the agent answered in plain text: the blocks are wisp's own reading of it */
  fallback?: boolean;
}

/** One turn (model.rs Turn) plus v1's per-turn fields the view reads. */
export interface Turn {
  id: string;
  sessionId: string;
  idx: number;
  prompt: string;
  agent: string;
  model: string;
  effort: string;
  account?: string;
  mode: Mode;
  attachments: Attachment[];
  /** who sent it, when not the user: 'wisp' (a goal check), 'compact', 'later', 'crew', 'channel' */
  by?: string;
  status: TurnStatus;
  startedAt: number;
  endedAt: number | null;
  held?: Held;
  stats: TurnStats | null;
  presentation: Presentation | null;
  text?: string;
  isError?: boolean;
  changedFiles?: number;
  nEvents: number;
  /** v1 extras, flattened from ext by the summary hook */
  checkpoint?: { head: string; branch?: string; dirty?: boolean };
  rolledBackAt?: number;
  limit?: { kind: string; label?: string; resetsAt?: number; line?: string };
  refusal?: { text: string; by?: string };
  signedOut?: { agent: string; account?: string };
  moved?: string;
  goal?: { round: number };
  side?: { id: string; title: string };
  /** what moved since the last turn: CLI version, tool set, model catalogue (what-changed.js) */
  whatChanged?: { kind: string; from?: string; to?: string; text?: string }[];
  delegations?: { sessionId: string; turnId: string; name: string }[];
  ext?: Record<string, unknown>;
}

/** One event of the activity log (model.rs Activity, tagged by `kind`), with its place. */
interface EventBase {
  seq: number;
  session_id: string;
  turn_id: string;
  at: number;
}
export type Activity =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text?: string }
  | { kind: 'tool'; tool: ToolKind; label: string; file?: string; detail?: string; callId?: string; output?: string }
  | { kind: 'tool_output'; callId: string; text: string }
  | { kind: 'tool_error'; name: string; text: string }
  | { kind: 'blocked'; tool: string; detail: string; rule?: string }
  | { kind: 'notice'; text: string; tone?: 'info' | 'warn' | 'danger' };
export type EventRow = EventBase & Activity;

export type Row<T> = DeepReadonly<T>;
export type TaskRow = Row<Task>;
export type TurnRow = Row<Turn>;
export type { EntityKey };

export const KIND = {
  session: 'session',
  turn: 'turn',
  event: 'event',
  change: 'change',
  pr: 'pr',
  watch: 'watch',
  comment: 'comment',
} as const;

// Each area's own row shapes, kept beside this file so the switch to generated types stays one place.
export type * from './types-side.ts';
export type * from './types-cards.ts';
