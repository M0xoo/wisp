// The crew's tables (plan §4.8: v1's config.json crew list becomes rows) and the entities the store
// publishes on the 'crew' topic. Writing a row is the broadcast: clients subscribe to 'crew'.
import type { EntityDef, Migration, Store } from '@wisp/store';
import type { Held, KitFile, Member, Offer, SpellLock, TeamRow } from '@wisp-plugin/crew-api';

export const OWNER = 'wisp.crew';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE crew_member (
           id TEXT PRIMARY KEY, pos INTEGER NOT NULL, name TEXT NOT NULL, role TEXT, avatar TEXT, color TEXT, brief TEXT,
           cwd TEXT, machine TEXT, sandbox TEXT, agent TEXT, model TEXT, effort TEXT, mode TEXT, cron TEXT, on_kinds TEXT,
           parallel INTEGER, kit TEXT, team TEXT, paused INTEGER, notebook TEXT, wake_at INTEGER, checkins INTEGER,
           last_checkin_at INTEGER, last_minute INTEGER, held TEXT, spell TEXT, changed TEXT, offers TEXT,
           created_at INTEGER, updated_at INTEGER) STRICT;
         CREATE TABLE crew_queue (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, job TEXT NOT NULL) STRICT;
         CREATE INDEX crew_queue_member ON crew_queue (member_id, seq);
         CREATE TABLE crew_log (id INTEGER PRIMARY KEY, member_id TEXT NOT NULL, at INTEGER NOT NULL, entry TEXT NOT NULL) STRICT;
         CREATE INDEX crew_log_member ON crew_log (member_id, id);
         CREATE TABLE crew_link (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT, at INTEGER NOT NULL) STRICT;
         CREATE INDEX crew_link_member ON crew_link (member_id, at);
         CREATE TABLE crew_job (session_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, job TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
         CREATE INDEX crew_job_member ON crew_job (member_id, created_at);
         CREATE INDEX crew_job_running ON crew_job (member_id) WHERE state = 'running';
         CREATE TABLE crew_seen (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
         CREATE INDEX crew_seen_at ON crew_seen (at);
         CREATE TABLE crew_layout (member_id TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL) STRICT;`,
  },
];

export interface MemberRow {
  [k: string]: unknown;
  id: string;
  pos: number;
  name: string;
  role: string;
  avatar: string;
  color: string;
  brief: string;
  cwd: string;
  machine: string;
  sandbox: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
  cron: string;
  on_kinds: string[];
  parallel: number;
  kit: KitFile[];
  team: TeamRow[];
  paused: boolean;
  notebook: string;
  wake_at: number | null;
  checkins: number;
  last_checkin_at: number | null;
  last_minute: number | null;
  held: Held | null;
  spell: SpellLock | null;
  changed: Member['changed'] | null;
  offers: Offer[];
  created_at: number;
  updated_at: number;
}

export interface QueueRow {
  [k: string]: unknown;
  id: string;
  member_id: string;
  seq: number;
  at: number;
  job: unknown;
}
export interface LogRow {
  [k: string]: unknown;
  id?: number;
  member_id: string;
  at: number;
  entry: unknown;
}
export interface LinkRow {
  [k: string]: unknown;
  id: string;
  member_id: string;
  task_id: string;
  title: string;
  at: number;
}
export interface JobDbRow {
  [k: string]: unknown;
  session_id: string;
  member_id: string;
  job: string;
  state: string;
  created_at: number;
  updated_at: number;
}
export interface SeenRow {
  [k: string]: unknown;
  id: string;
  member_id: string;
  at: number;
}
export interface LayoutRow {
  [k: string]: unknown;
  member_id: string;
  x: number;
  y: number;
}

export interface Entities {
  member: EntityDef<MemberRow>;
  queue: EntityDef<QueueRow>;
  log: EntityDef<LogRow>;
  link: EntityDef<LinkRow>;
  job: EntityDef<JobDbRow>;
  seen: EntityDef<SeenRow>;
  layout: EntityDef<LayoutRow>;
}

const crew = (): readonly ['crew'] => ['crew'];

/** Migrates the crew's tables and registers its entities (setup, once). */
export function defineCrew(store: Store): Entities {
  store.migrate(OWNER, MIGRATIONS);
  const t = 'text' as const;
  const i = 'int' as const;
  return {
    member: store.defineEntity<MemberRow>({
      kind: 'crew.member', table: 'crew_member', key: 'id', topics: crew,
      columns: {
        id: t, pos: i, name: t, role: t, avatar: t, color: t, brief: t, cwd: t, machine: t, sandbox: t, agent: t, model: t, effort: t, mode: t, cron: t,
        on_kinds: t, parallel: i, kit: t, team: t, paused: 'bool', notebook: t, wake_at: i, checkins: i, last_checkin_at: i, last_minute: i,
        held: t, spell: t, changed: t, offers: t, created_at: i, updated_at: i,
      },
      json: ['on_kinds', 'kit', 'team', 'held', 'spell', 'changed', 'offers'],
    }),
    queue: store.defineEntity<QueueRow>({ kind: 'crew.queue', table: 'crew_queue', key: 'id', topics: crew, columns: { id: t, member_id: t, seq: i, at: i, job: t }, json: ['job'] }),
    log: store.defineEntity<LogRow>({ kind: 'crew.log', table: 'crew_log', key: 'id', topics: crew, columns: { id: i, member_id: t, at: i, entry: t }, json: ['entry'] }),
    link: store.defineEntity<LinkRow>({ kind: 'crew.link', table: 'crew_link', key: 'id', topics: crew, columns: { id: t, member_id: t, task_id: t, title: t, at: i } }),
    job: store.defineEntity<JobDbRow>({ kind: 'crew.job', table: 'crew_job', key: 'session_id', topics: crew, columns: { session_id: t, member_id: t, job: t, state: t, created_at: i, updated_at: i } }),
    seen: store.defineEntity<SeenRow>({ kind: 'crew.seen', table: 'crew_seen', key: 'id', topics: crew, columns: { id: t, member_id: t, at: i } }),
    layout: store.defineEntity<LayoutRow>({ kind: 'crew.layout', table: 'crew_layout', key: 'member_id', topics: crew, columns: { member_id: t, x: i, y: i } }),
  };
}

export function toRow(m: Member, pos: number): MemberRow {
  return {
    id: m.id, pos, name: m.name, role: m.role, avatar: m.avatar, color: m.color, brief: m.brief, cwd: m.cwd, machine: m.machine, sandbox: m.sandbox,
    agent: m.agent, model: m.model, effort: m.effort, mode: m.mode, cron: m.cron, on_kinds: m.on, parallel: m.parallel, kit: m.kit, team: m.team,
    paused: m.paused, notebook: m.notebook, wake_at: m.wakeAt, checkins: m.checkins, last_checkin_at: m.lastCheckinAt, last_minute: m.lastMinute,
    held: m.held ?? null, spell: m.spell ?? null, changed: m.changed ?? null, offers: m.offers, created_at: m.createdAt, updated_at: m.updatedAt,
  };
}

export function fromRow(r: MemberRow): Member {
  return {
    id: r.id, name: r.name, role: r.role ?? '', avatar: r.avatar ?? '', color: r.color ?? '', brief: r.brief ?? '', cwd: r.cwd ?? '', machine: r.machine ?? '',
    sandbox: r.sandbox === 'job' || r.sandbox === 'own' ? r.sandbox : '', agent: r.agent || 'auto', model: r.model ?? '', effort: r.effort ?? '',
    mode: r.mode === 'plan' || r.mode === 'edits' ? r.mode : 'auto', cron: r.cron ?? '', on: r.on_kinds ?? [], parallel: r.parallel || 2,
    kit: r.kit ?? [], team: r.team ?? [], paused: !!r.paused, notebook: r.notebook ?? '', wakeAt: r.wake_at ?? null, checkins: r.checkins ?? 0,
    lastCheckinAt: r.last_checkin_at ?? null, lastMinute: r.last_minute ?? null, ...(r.held && { held: r.held }), ...(r.spell && { spell: r.spell }),
    ...(r.changed && { changed: r.changed }), offers: r.offers ?? [], createdAt: r.created_at ?? 0, updatedAt: r.updated_at ?? 0,
  };
}
