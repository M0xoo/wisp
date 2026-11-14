// The rows this UI reads, in one file so switching to @wisp/protocol's generated types (ts-rs, from
// crates/wisp-later-api) is one edit. Until then the truth is v1 (server/later.js laterView,
// server/runner.js summarize's later/reminder/forLater/held) and the TypeScript reference port
// (git show v2-ts-server-reference:plugins/later/api/src/index.ts).

/**
 * Entity kinds and topics, as the peer sends them. Assumed: a task's follow-ups ride on its list row
 * ('session', topic 'list': `later`, `reminder`, `forLater`, `held`), and plans are their own rows
 * ('later_plan') on the same 'list' topic, since the list shows them beside the tasks.
 */
export const KIND = { session: 'session', plan: 'later_plan' } as const;
export const TOPIC = { list: 'list' } as const;
export const PLUGIN = 'wisp.later';

export const MIN_MS = 60_000;
export const MAX_MS = 30 * 24 * 3600_000;
export const PER_TASK = 5;
export const TEXT_MAX = 4000;

/** Automations stop at moved it to the reset; load: the machine's, not the plan's. */
export interface LaterHeld {
  why: string;
  until: number;
  load?: true;
}

/** A follow-up or reminder on a task (v1 laterView). by: 'user', 'agent', a member's name, 'wisp'. */
export interface LaterView {
  id: string;
  at: number;
  text: string;
  by: string;
  setAt: number;
  remind?: true;
  files?: number;
  held?: LaterHeld;
  /** the goal round it starts */
  goal?: number;
}

/** A reminder that came due on a task. */
export interface Reminder {
  text: string;
  at: number;
  setAt: number;
  by: string;
  from?: { id: string; title: string };
  missed?: true;
}

export interface ForLater {
  at: number;
  by: string;
}

/** A run held near the limit (v1 summarize's `held`, server/guard.js). */
export interface Held {
  kind: 'first' | 'followUp' | (string & {});
  label?: string;
  used?: number;
  to?: [number, number];
  line?: number;
  resetsAt?: number;
  until?: number;
  waiting?: boolean;
  /** held for a changed harness: Trust and start */
  harness?: unknown;
  /** held for a repo's hooks or servers: Trust and start, Run without them */
  project?: { count: number; changed?: boolean; setup?: string };
}

/** A task row as the list holds it: the fields Later reads. */
export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  cwd?: string;
  project?: string;
  color?: string;
  state: 'running' | 'waiting' | 'review' | 'done' | 'idle' | (string & {});
  unread?: boolean;
  archived?: boolean;
  pending?: boolean;
  createdAt?: number;
  updatedAt: number;
  later?: LaterView[];
  reminder?: Reminder;
  forLater?: ForLater;
  held?: Held;
  /** 'reminder': a reminder of its own, nothing to talk to */
  kind?: string;
  parentId?: string;
  tui?: boolean;
  term?: boolean;
  origin?: { kind: string; id: string; name?: string } | null;
  crew?: { id: string; job: string };
  machine?: { name?: string } | string;
}

/** A launch body (runtime StartArgs) a task plan keeps. */
export interface PlanBody {
  prompt: string;
  agent?: string;
  mode?: string;
  model?: string;
  cwd?: string;
  [k: string]: unknown;
}

/** A task or reminder that hasn't started (v1 config.later[]). */
export interface Plan {
  id: string;
  kind: 'task' | 'reminder';
  setAt: number;
  at?: number;
  draft?: true;
  after?: { id: string; title: string };
  lost?: { id: string; title: string; why: 'deleted' | 'archived' };
  body?: PlanBody;
  title?: string;
  text?: string;
  from?: { id: string; title: string };
}
