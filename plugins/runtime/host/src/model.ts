// The runtime's working shapes: a task and its turns as v1 kept them (server/runner.js, store.js),
// field for field. The runner's rules were written against these and its tests read them, so the
// port keeps them and maps them to rows (persist.ts) and to the api's Session/Turn (view.ts).
// A session is in memory only while it is open or running (ADR-0011: lazy by default).

import type { Json } from '@wisp/kernel';
import type { Attachment, Mode } from '@wisp-plugin/runtime-api';

export type { Mode };
export type SessionState = 'running' | 'waiting' | 'review' | 'done' | 'error';
export type TurnStatus = 'running' | 'done' | 'error' | 'held' | 'stopped';

/** One step of a turn's activity (v1 runner.js stepOf). Stored as one event row each. */
export interface Step {
  t: number;
  kind: string;
  label?: string;
  file?: string;
  detail?: string;
  /** the harness's call id: a tool_output later finds its call by this */
  call?: string;
  output?: string;
  /** when the call's output came in, nothing printed included */
  outAt?: number;
  /** [from, to) in the turn's change entry for `file`: the edits this call made */
  edits?: [number, number];
  by?: string;
  /** the event row's seq, once stored (not part of v1's JSON) */
  seq?: number;
}

export interface Edit {
  before?: string;
  after?: string;
  [k: string]: unknown;
}

export interface Change {
  file: string;
  op: string;
  beforeFile?: string | null;
  edits: Edit[];
  reverted?: boolean;
  by?: string[];
  [k: string]: unknown;
}

export interface Block {
  type: string;
  [k: string]: unknown;
}

export interface Presentation {
  blocks: Block[];
  notes?: string;
  topic?: string;
  fallback?: boolean;
  [k: string]: unknown;
}

export interface Stats {
  costUsd?: number;
  cli?: Record<string, unknown>;
  compact?: unknown;
  totals?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Delegation {
  id: string;
  name: string;
  member: string;
  agent: string;
  model: string;
  effort: string;
  sessionId: string;
  turnId: string;
  prompt: string;
  startedAt: number;
  owed?: boolean;
  crew?: string;
  place?: string;
}

export interface Btw {
  id: string;
  question: string;
  status: 'running' | 'done' | 'error';
  askedAt: number;
  agent: string;
  model: string;
  attachments?: Attachment[];
  forked?: boolean;
  answer?: string;
  error?: string;
  answeredAt?: number;
  costUsd?: number;
  crew?: unknown;
}

export interface Blocked {
  tool: string;
  detail: string;
  rule?: string;
  why?: string;
}

/** v1 turn.held: the card a held run shows (Start now, Wait, Skip). */
export interface Held {
  kind: 'first' | 'followUp';
  agent: string;
  /** the plugin that held it, and its reason ('limit', 'harness', 'project') */
  by?: string;
  reason?: string;
  until?: number;
  at: number;
  project?: { items: { id: string }[]; changed?: boolean; setup?: unknown; [k: string]: unknown };
  harness?: unknown;
  [k: string]: unknown;
}

/** What a queued follow-up or a held turn carries until it goes (v1 reply()'s `extra`). */
export interface RunOpts {
  mode?: Mode;
  run?: { agent: string; model: string; effort: string; account?: string };
  team?: Member[];
  grants?: string[];
  once?: Mode;
  by?: string;
  later?: Json;
  goal?: Json;
  side?: { id: string; title: string };
  reports?: boolean;
  account?: string;
}

export interface QueueItem extends RunOpts {
  id: string;
  text: string;
  attachments: Attachment[];
  /** ahead of the rest: it interrupts the run (v1 `now`) */
  now?: boolean;
}

export interface Turn {
  id: string;
  prompt: string;
  agent: string;
  model: string;
  effort: string;
  account?: string;
  mode: Mode;
  attachments: Attachment[];
  startedAt: number;
  endedAt: number | null;
  status: TurnStatus;
  checkpoint?: Json | null;
  activity: Step[];
  changes: Change[];
  presentation: Presentation | null;
  stats: Stats | null;
  raw?: string;
  by?: string;
  held?: Held;
  run?: { attachments?: Attachment[]; opts?: RunOpts; subagentModel?: string; skills?: string };
  delegations?: Delegation[];
  btw?: Btw[];
  blocked?: Blocked[];
  denied?: { tool: string; detail: string }[];
  approval?: 'allowed' | 'denied';
  limit?: { account: string; until: number; others: Json[]; kind: string; extra: string; waiting?: boolean };
  signedOut?: { agent: string; account: string; scope: string; others: Json[]; oldCli?: boolean; stillIn?: boolean; rerun?: number };
  refusal?: { agent: string; model: string; vendor?: string; kind: string; line?: string };
  devices?: boolean;
  overage?: { kind: string; at: number };
  trimmed?: number;
  plain?: boolean;
  interim?: { text: string; stats?: Stats };
  background?: string[];
  details?: { tools?: Json; [k: string]: unknown };
  relay?: { state: string; [k: string]: unknown };
  side?: { id: string; title: string };
  reports?: boolean;
  untrusted?: boolean;
  later?: Json;
  goal?: Json;
  was?: { state: SessionState; unread: boolean };
  quiet?: boolean;
  skipped?: boolean;
  tui?: boolean;
  sideWarn?: { kind: string; file?: string; [k: string]: unknown }[];
  harness?: Json;
  moved?: string;
  forked?: boolean;
  shared?: boolean;
  rolledBackAt?: number;
  /** owned by other plugins, namespaced by plugin id */
  ext?: Record<string, Json>;
}

export interface Member {
  name: string;
  agent: string;
  model: string;
  effort: string;
  use?: string;
  count?: number;
  crew?: string;
  label?: string;
  role?: string;
  machine?: string;
  place?: string;
  upstream?: boolean;
}

export interface Ask {
  id: string;
  question: string;
  context: string;
  options: string[];
  askedAt: number;
  permission?: { tool: string; action: string; detail: string };
  connector?: Json;
  clash?: { file?: string; command?: string; [k: string]: unknown };
  answer?: string;
}

export interface Session {
  id: string;
  title: string;
  titleAuto?: boolean;
  agent: string;
  cwd: string;
  /** where the agent works: its worktree when it has one (set by wisp.worktrees), else cwd */
  workdir?: string;
  /** the task's other folders, where the work in them goes (v1 alsoDirs) */
  dirs?: string[];
  mode: Mode;
  model: string;
  effort: string;
  account?: string;
  state: SessionState;
  unread: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  agentSessionId: string | null;
  agentSessions: Record<string, string>;
  queue: QueueItem[];
  queueHeld?: boolean;
  turns: Turn[];
  tags?: string[];
  ask?: Ask;
  grants?: { tool: string; detail: string }[];
  subagents?: Member[];
  children?: Record<string, string>;
  parentId?: string;
  member?: string;
  relay?: { machine: string; place: string; upstream?: boolean; crew?: string };
  delegated?: { lead: string; name: string };
  kind?: string;
  origin?: Json;
  groupId?: string;
  capped?: { mode: Mode };
  sideOf?: { id: string; title: string; cwd: string };
  sides?: string[];
  forkedFrom?: { id: string; title: string; turn: number; of: number };
  forks?: string[];
  moved?: Json;
  movedTo?: Json;
  sharedFrom?: Json;
  tui?: boolean;
  lean?: 'on' | 'off';
  subagentModel?: string;
  skills?: string;
  trial?: Json;
  savedStuff?: string[];
  /** owned by other plugins, namespaced by plugin id: ext['wisp.goal'], ext['wisp.worktrees'], … */
  ext: Record<string, Json>;
}

export const MODES: ReadonlySet<string> = new Set(['plan', 'edits', 'auto']);
export const isMode = (m: unknown): m is Mode => typeof m === 'string' && MODES.has(m);

/** Where the agent actually works: a side discussion reads its main task's folder (v1 workdir). */
export const workdir = (s: Session): string => s.sideOf?.cwd || s.workdir || s.cwd;
