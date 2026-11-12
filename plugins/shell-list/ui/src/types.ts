// Every row shape this plugin reads, in one file (docs/v2-ui-brief.md): when
// packages/protocol/src/generated/ exports the Rust row types (ts-rs), this file re-exports them and
// nothing else changes. Until then the truth is v1's `summarize()` (server/runner.js:250) and the
// `/load`, `/machine`, `/projects` and `/machines` answers.

import type { DeepReadonly, EntityKey } from '@wisp/client';
import type { ProjectColor } from '@wisp/tokens';

export type SessionState = 'running' | 'waiting' | 'review' | 'done';
/** The agent's verdict on its last turn (`status`), plus wisp's own halt words. */
export type Verdict = 'done' | 'partial' | 'blocked' | 'failed' | 'limit' | 'refused' | 'signedOut' | 'info' | 'held' | 'running';
export type Halt = 'limit' | 'signedOut' | 'refused' | 'failed';
/** v1's project colour names; the kit's tokens are `pc-<name>`. */
export type ColorName = 'violet' | 'teal' | 'amber' | 'rose' | 'sky' | 'lime' | 'orange' | 'indigo' | 'slate';

export interface PrRef {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft?: boolean;
  review?: string;
  checks?: 'pass' | 'fail' | 'pending' | string;
  conflict?: boolean;
}

export interface Held {
  kind: string;
  label?: string;
  used?: number;
  until?: number;
  waiting?: boolean;
  harness?: string;
  project?: { count: number; changed?: boolean; setup?: unknown };
}

/** A follow-up or reminder scheduled on a task (server/later.js laterView). */
export interface LaterItem {
  id: string;
  at: number;
  text: string;
  remind?: boolean;
  by?: 'user' | 'agent' | string;
  goal?: number;
  /** moved to the plan's reset, or held by the RAM/CPU guard (`load`) */
  held?: { load?: boolean; why: string };
}

export interface MachineRef {
  id: string;
  name: string;
  kind?: 'ssh' | 'grid' | 'sandbox';
  state?: MachineState;
  target?: string;
}

/** A task as the list sees it: v1's summary, keyed in the entity store as `<peer>:<id>`. */
export interface Session {
  id: string;
  title: string;
  agent: string;
  cwd?: string;
  project?: string;
  projectId?: string | null;
  color?: ColorName;
  model?: string;
  effort?: string;
  state: SessionState;
  status?: Verdict;
  halt?: Halt;
  unread?: boolean;
  archived?: boolean;
  pinned?: boolean;
  forLater?: { at: number; by?: 'you' | 'crew' };
  createdAt: number;
  updatedAt: number;
  queued?: number;
  queueHeld?: boolean;
  later?: LaterItem[];
  reminder?: { text: string; at: number };
  pending?: boolean;
  preview?: string;
  held?: Held;
  tags?: string[];
  live?: string;
  term?: boolean;
  tui?: boolean;
  res?: { rss: number; cpu?: number };
  asks?: boolean;
  question?: string;
  options?: string[];
  approval?: boolean;
  branch?: string;
  foreign?: string;
  also?: { projectId: string | null; project: string; color: ColorName; branch?: string }[];
  shipping?: { step: string } | null;
  pr?: PrRef | null;
  groupId?: string | null;
  origin?: { kind: 'recipe' | 'trigger' | 'telegram'; id?: string; name?: string } | null;
  kind?: string;
  parentId?: string;
  member?: string;
  crew?: { id: string; job?: string };
  sideOf?: { id: string; title: string };
  machine?: MachineRef;
  goal?: { status: string; text?: string; round?: number; checks?: { progress?: number }[]; last?: { why?: string } };
  overlaps?: { id: string; title?: string; files: string[]; conflicts?: string[] }[];
  team?: { name: string; agent: string; busy?: boolean }[];
}

/** A scheduled task or reminder that hasn't started (Scheduled), or a /draft (Drafts): rows of their own. */
export interface Plan {
  id: string;
  kind: 'task' | 'reminder' | 'draft';
  title: string;
  at: number;
  agent?: string;
  projectId?: string | null;
  project?: string;
  color?: ColorName;
  every?: string;
  /** an /after plan: the title of the task it waits for (v1 planSub) */
  after?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: ColorName;
  machine?: string;
  lastUsedAt?: number;
  addedAt?: number;
}

export type MachineState = 'online' | 'asleep' | 'connecting' | 'reconnecting' | 'error' | 'off';

export interface Machine {
  id: string;
  name: string;
  kind: 'ssh' | 'grid' | 'sandbox';
  state: MachineState;
  target?: string;
}

/** `/load` and the bits of `/machine` the chip reads (server/load.js). One row, id `here`. */
export interface Load {
  id: string;
  platform?: string;
  memFreePct: number | null;
  runs: number;
  floor?: number;
  held?: { kind: string; why: string } | null;
  pausedUntil?: number | null;
  left?: number;
}

/** The signed-in account, the grid and what the top bar's menu needs (config). One row, id `me`. */
export interface Me {
  id: string;
  name?: string;
  handle?: string;
  host?: string;
  picture?: string;
  connected?: boolean;
  inGrid?: boolean;
  automations?: { recipes: number; triggers: number };
  update?: { current: string; latest: string } | null;
  getAppHidden?: boolean;
}

/** An agent (harness) the peer offers: name and models, for the row's run line. */
export interface Agent {
  id: string;
  name: string;
  models?: { id: string; label: string }[];
}

export type Row<T> = DeepReadonly<T>;
export type SessionRow = Row<Session>;
export type { EntityKey };

export const KIND = {
  session: 'session',
  plan: 'later_plan',
  project: 'project',
  machine: 'machine',
  load: 'load',
  me: 'me',
  agent: 'agent',
} as const;

export const colorToken = (c: ColorName | undefined): ProjectColor => `pc-${c ?? 'slate'}`;
