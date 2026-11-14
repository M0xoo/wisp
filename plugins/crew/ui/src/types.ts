// The rows this UI reads, in one file so switching to @wisp/protocol's generated types (ts-rs, from
// crates/wisp-crew-api) is one edit. Until then the truth is v1 (server/crew.js memberView, server/
// runner.js summarize) and the TypeScript reference port (git show v2-ts-server-reference:plugins/
// crew/api/src/index.ts).

/** Entity kinds and topics, as the peer sends them. */
export const KIND = { member: 'crew_member', session: 'session' } as const;
export const TOPIC = { crew: 'crew', list: 'list' } as const;
export const PLUGIN = 'wisp.crew';

export const MAX_CREW = 12;
export const MAX_PARALLEL = 5;
export const BRIEF_MAX = 4000;
export const NOTEBOOK_SOFT = 6000;
export const NOTEBOOK_MAX = 12000;
export const CREW_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'] as const;
export type CrewColor = (typeof CREW_COLORS)[number];
export type JobKind = 'checkin' | 'task' | 'delegated' | 'trigger' | 'mention' | 'event';
/** Jobs nobody waits on: one that found nothing is filed (quiet) or saved for later. */
export const QUIET_JOBS: ReadonlySet<string> = new Set<JobKind>(['checkin', 'event']);
export const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;

// ---------- rows ----------

export interface KitFile {
  id: string;
  kind: 'skill' | 'rules';
  name: string;
  description?: string;
  body: string;
  /** a skill imported from this computer keeps its folder, for the files beside its SKILL.md */
  path?: string;
  on: boolean;
}

/** A file a job proposed for the kit (no id, path or on yet). */
export type OfferFile = Omit<KitFile, 'id' | 'path' | 'on'>;

/** One of a member's delegates (v1 subagents.js normalizeTeam's row). */
export interface TeamRow {
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

export interface Held {
  at?: number;
  why: string;
  until?: number;
  agent?: string;
  load?: boolean;
}

export interface Offer {
  id: string;
  /** the task whose turn proposed it */
  job: string;
  turn?: string;
  at: number;
  files: OfferFile[];
  state: 'open' | 'taken' | 'dismissed';
  names?: string[];
  settledAt?: number;
}

export interface SpellLock {
  id: string;
  key: string;
  name: string;
  def: Record<string, unknown>;
}

export interface Member {
  id: string;
  name: string;
  role: string;
  /** a spirit code, an emoji, or '' (rolled from the name) */
  avatar: string;
  color: string;
  /** the list's tint while they're picked (v1 `bg`): '' their glow, 'none', or a crew colour */
  bg?: string;
  brief: string;
  cwd: string;
  /** '' = this computer */
  machine: string;
  sandbox: '' | 'job' | 'own';
  agent: string;
  model: string;
  effort: string;
  mode: 'plan' | 'edits' | 'auto';
  cron: string;
  /** what else starts its jobs (automations.syncMember kinds: finished, done, ci) */
  on: string[];
  parallel: number;
  kit: KitFile[];
  team: TeamRow[];
  paused: boolean;
  notebook: string;
  wakeAt: number | null;
  checkins: number;
  lastCheckinAt: number | null;
  lastMinute: number | null;
  /** skipped for the plan (or a busy computer) until it resets */
  held?: Held;
  spell?: SpellLock;
  changed?: { from: Record<string, unknown> | null; at: number };
  offers: Offer[];
  /** what else wakes them (ADR-0043): trigger specs targeting this member */
  wakes?: { on: string; match?: Record<string, unknown> }[];
  createdAt: number;
  updatedAt: number;
}

export interface LogEntry {
  at: number;
  job: string;
  title: string;
  summary: string;
  /** what it was asked */
  prompt?: string;
  from?: { id: string; title: string };
  status: string;
  quiet?: boolean;
  forLater?: boolean;
  /** skips in a row share one line */
  skipped?: number;
  sessionId?: string;
}

/** Where a job's answer goes: an entry under a message in another task. */
export interface ReplyTo {
  sessionId: string;
  turnId: string;
  entryId: string;
}

/** A job waiting in a member's queue. */
export interface WaitingJob {
  id: string;
  prompt: string;
  job: JobKind;
  from?: { id: string; title: string };
  origin?: Record<string, unknown>;
  attachments?: unknown[];
  reply?: ReplyTo;
  wake?: boolean;
  event?: 'finished' | 'done';
  kit?: boolean;
  team?: TeamRow[];
  unattended?: boolean;
  /** your own job near the limit: 'yes' once you said so, 'ask' to ask */
  limit?: 'yes' | 'ask';
  run?: { model?: string; effort?: string; mode?: string };
  /** the channel thread it came from (channels answers there) */
  thread?: Record<string, unknown>;
  at: number;
}

export interface Link {
  id: string;
  title: string;
  at: number;
}

/** What the crew keeps on a job's task: `session.ext['wisp.crew']`. */
export interface CrewExt {
  id: string;
  job: JobKind;
  from?: { id: string; title: string };
  reply?: ReplyTo;
  wake?: boolean;
  event?: 'finished' | 'done';
  kit?: boolean;
  /** tasks it followed up on */
  sent?: { id: string; title: string }[];
  /** a job another wisp sent here for its member: that wisp wrote the note */
  note?: string;
}

/** An answer a member gives under a message (v1 turn.btw entries with crew): `turn.ext['wisp.crew'].entries`. */
export interface CrewEntry {
  id: string;
  question: string;
  status: 'running' | 'done' | 'error';
  askedAt: number;
  crew: { id: string; name: string; avatar: string; color: string };
  job?: string;
  queued?: boolean;
  answer?: string;
  error?: string;
  answeredAt?: number;
  thread?: string;
}

/** One job of a member, as the crew indexes it (crew_job). */
export interface JobRow {
  sessionId: string;
  crewId: string;
  job: string;
  state: string;
  createdAt: number;
  updatedAt: number;
}

/** A member as the page and the API see it: its jobs running, what's next, its memory. */
export interface MemberView extends Member {
  handle: string;
  running: number;
  jobs: number;
  nextAt: number | null;
  log: LogEntry[];
  queue: WaitingJob[];
  links: Link[];
}


/** A task row as the list holds it (v1 summarize), the fields the crew UI reads. */
export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  project?: string;
  color?: string;
  state: 'running' | 'waiting' | 'review' | 'done' | 'idle' | (string & {});
  status?: string;
  unread?: boolean;
  archived?: boolean;
  pending?: boolean;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  live?: string;
  asks?: boolean;
  question?: string;
  forLater?: { at: number; by?: string };
  parentId?: string;
  member?: string;
  machine?: string;
  /** a crew member's job */
  crew?: { id: string; job: JobKind; from?: { id: string; title: string }; event?: 'finished' | 'done'; prompt?: string; sent?: { id: string; title: string }[]; kit?: boolean };
  team?: { name: string; agent: string; model: string; effort: string; used: boolean; busy: boolean; crew?: string }[];
}
