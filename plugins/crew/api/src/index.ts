// @wisp-plugin/crew-api: the contract of wisp.crew (v1 server/crew.js). Named, long-lived agents the
// user keeps on hand ("Ada · CI watcher"): an identity, a brief, a schedule and a memory. Their work
// runs as ordinary tasks (runtime.create with ext['wisp.crew'] = CrewExt), several at once; jobs past
// a member's `parallel` wait in its queue. Members, their queue, log, links and the jobs index are
// rows (crew_* tables, topic 'crew'); their kit files (SKILL.md) stay files under paths.dir('crew').

export { CREW_MENTION, crewMentions, handleOf, mentionOf, plainCrew } from './mentions.ts';
export type { Mentions, Named } from './mentions.ts';
export { KIT_BODY_MAX, KIT_MAX, KIT_TOTAL_MAX, RULES_NAME, SKILL_NAME, parseSkillMd, skillMd, skillName } from './skill-md.ts';
export type { SkillMd } from './skill-md.ts';
export { byUrgency, CARD_ROWS, cardJobs, headingForCard, holdRows, jobMark, jobRank, standing, stepRow } from './jobs.ts';
export type { JobLike } from './jobs.ts';
export * from './feed.ts';
export { CREW_FIELDS, CREW_TOOLS, EDIT_FIELDS, MEMBER_PROPS, NOTEBOOK_PROPS, memberDetail, memberLine } from './tools.ts';
export type { LineMember } from './tools.ts';

export const PLUGIN = 'wisp.crew';
export const TOPIC = 'crew';

export const MAX_CREW = 12;
export const MAX_PARALLEL = 5;
export const BRIEF_MAX = 4000;
export const NOTEBOOK_SOFT = 6000; // what the member is asked to stay under
export const NOTEBOOK_MAX = 12000; // past this the oldest lines go
export const CREW_COLORS: readonly string[] = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];
export type JobKind = 'checkin' | 'task' | 'delegated' | 'trigger' | 'mention' | 'event';
export const JOBS: ReadonlySet<string> = new Set<JobKind>(['checkin', 'task', 'delegated', 'trigger', 'mention', 'event']);
/** Jobs nobody waits on: one that found nothing is filed (quiet) or saved for later. */
export const QUIET_JOBS: ReadonlySet<string> = new Set<JobKind>(['checkin', 'event']);
export const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
/** A spell's member: the spell owns these fields of its blueprint (Make it mine lets go). */
export const DEFINITION: readonly string[] = ['name', 'role', 'avatar', 'color', 'brief', 'cron', 'on', 'mode', 'kit', 'team'];
/** A spell changing one of these pauses the member until you've seen the change. */
export const REVIEWED: readonly string[] = ['brief', 'kit', 'cron', 'on', 'mode'];

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

// ---------- commands (permission: crew:read for reads, crew:write for changes to the crew) ----------

export const COMMANDS = {
  list: 'crew.list', // {} → MemberView[]   (read-only)
  get: 'crew.get', // { id } → Member   (read-only; not_found)
  find: 'crew.find', // { key } → Member | null   (id, name or @handle; read-only)
  view: 'crew.view', // { id } → MemberView & { jobList }   (read-only)
  busy: 'crew.busy', // { id } → { running }   (read-only)
  mentions: 'crew.mentions', // { text } → { lead, all, rest, delegates }   (read-only: who a prompt names)
  localKit: 'crew.localKit', // { cwd? } → { skills, rules }   (read-only: kit files on this computer)
  layout: 'crew.layout', // {} → { [id]: { x, y } }   (read-only)
  nextWake: 'crew.nextWake', // {} → { at }   (read-only: the soonest check-in, for /status)
  create: 'crew.create', // body (+ on?, checkin?) → MemberView & { session? }
  update: 'crew.update', // { id, ...body } → MemberView
  remove: 'crew.remove', // { id } → { ok }
  detach: 'crew.detach', // { id } → MemberView   (Make it mine)
  adopt: 'crew.adopt', // { sessionId, ...body } → MemberView   (a task joins the crew)
  setLayout: 'crew.setLayout', // { layout } → { [id]: { x, y } }
  export: 'crew.export', // { ids, kit?, notebook?, team?, gist? } → { bundle, notes, file, gist? }
  import: 'crew.import', // { text | url | bundle, dryRun?, choices? } → { members } | { spell }
  // handing work (permission crew:assign)
  assign: 'crew.assign', // { crewId, prompt, job?, from?, reply?, … } → { session? , queued?, member }
  checkin: 'crew.checkin', // { crewId } → { session? , queued? } | { already }
  ask: 'crew.ask', // { crewId, sessionId, text, attachments?, tagged? } → { entry, session?, queued? }
  askFirst: 'crew.askFirst', // { crewId, prompt } → {}   (conflict with the hold near your limit)
  start: 'crew.start', // { prompt, attachments?, confirmLimit? } → Summary | { queued } | null (POST /sessions "@Ada …")
  reply: 'crew.reply', // { sessionId, text, attachments? } → { crew: CrewEntry[] } | null   (a follow-up "@Ada …")
  replyIn: 'crew.replyIn', // { sessionId, entry, text } → CrewEntry   (you reply in a member's thread)
  propose: 'crew.propose', // { crewId, sessionId, files } → { offer, refused }   (permission crew:propose)
  release: 'crew.release', // { agent } → { released }   (permission crew:release)
} as const;

export const EVENTS = {
  /** a member was added, changed or left: { id, op: 'create' | 'update' | 'remove' } */
  changed: 'crew.changed',
  /** a member left the crew: automations turns off the triggers that sent it work. { id, name } */
  removed: 'crew.removed',
  /** a job from a channel thread began (sessionId) or couldn't (error): { crewId, sessionId, thread, error? } */
  started: 'crew.started',
} as const;
