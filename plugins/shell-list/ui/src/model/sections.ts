// Which section every task sits in, and in what order: v1's groups() (web/js/features/feed.js:85),
// pure. Needs you, Working, Scheduled, For later, Done and Archived; Drafts and Scheduled's plans
// are rows of their own (plans.ts). Compare runs (one launch on several harnesses, one groupId) are
// one task while two or more sit on the same side of archived.

import type { EntityKey, Plan, Row, Session, SessionRow } from '../types.ts';

export type SectionId = 'needs' | 'working' | 'scheduled' | 'drafts' | 'forLater' | 'done' | 'archived';
export const SECTION_IDS: readonly SectionId[] = ['needs', 'working', 'scheduled', 'drafts', 'forLater', 'done', 'archived'];

export interface Keyed {
  readonly key: EntityKey;
  readonly s: SessionRow;
}

/** One entry of a section: a task, or a compare task with a row per run. */
export type Entry =
  | { readonly kind: 'task'; readonly key: EntityKey; readonly s: SessionRow }
  | { readonly kind: 'group'; readonly key: string; readonly runs: readonly Keyed[]; readonly state: Session['state']; readonly updatedAt: number }
  | { readonly kind: 'plan'; readonly key: string; readonly plan: Row<Plan> };

export type Sections = Readonly<Record<SectionId, readonly Entry[]>>;

export interface Filter {
  /** a project id, or 'all' */
  readonly project: string;
  /** a crew member: only its jobs; undefined: everything */
  readonly crew?: string;
  /** a crew member's job that lives under that member, not in the list (crew rail) */
  readonly underMember?: (s: SessionRow) => boolean;
}

export const ALL: Filter = { project: 'all' };

export const inProject = (s: SessionRow, project: string): boolean => project === 'all' || s.projectId === project || (s.also ?? []).some((a) => a.projectId === project);

/** Saved for later: out of Needs you, Scheduled and Done meanwhile (core/state.js isForLater). */
export const isForLater = (s: SessionRow): boolean => !!s.forLater && !s.archived && !s.reminder && !s.pending && (s.state === 'review' || s.state === 'done');

/** Waiting on follow-ups (design/later.md): in Scheduled, out of Needs you. */
export function isScheduled(s: SessionRow): boolean {
  if (s.archived || s.forLater) return false;
  if (s.state === 'done') return !!s.later?.length || !!s.held?.waiting;
  return s.state === 'review' && !s.reminder && !s.held && !s.pending && !(s.tui && s.term) && !!s.later?.some((l) => !l.remind);
}

/** Asking you, or a report you haven't read: the tab title, the dots, the project counts. */
export const needsYou = (s: SessionRow): boolean => !isForLater(s) && !s.archived && !isScheduled(s) && (s.state === 'waiting' || (s.state === 'review' && !!s.unread));

/** When a scheduled task's next thing happens: its follow-up, or its held run's reset. */
export const nextAt = (s: SessionRow): number => Math.min(s.later?.[0]?.at ?? Infinity, s.held?.waiting ? (s.held.until ?? Infinity) : Infinity);

/** A terminal task with its terminal open is being worked on, by you and its agent. */
const inTerm = (s: SessionRow): boolean => !!s.tui && !!s.term && s.state === 'review';

const groupState = (runs: readonly Keyed[]): Session['state'] =>
  runs.some((r) => r.s.state === 'waiting') ? 'waiting'
  : runs.some((r) => r.s.state === 'running') ? 'running'
  : runs.every((r) => r.s.state === 'done') ? 'done'
  : 'review';

/** Rows of one compare launch on the same side of archived, oldest first. */
function runsByGroup(all: readonly Keyed[]): Map<string, Keyed[]> {
  const out = new Map<string, Keyed[]>();
  for (const k of all) {
    if (!k.s.groupId) continue;
    const id = `${k.s.groupId}${k.s.archived ? ':a' : ''}`;
    const list = out.get(id);
    if (list) list.push(k);
    else out.set(id, [k]);
  }
  for (const list of out.values()) list.sort((a, b) => a.s.createdAt - b.s.createdAt);
  return out;
}

/** The task as a whole: asking if any run asks, working while any works, done once all are. */
function entryOf(k: Keyed, groups: Map<string, Keyed[]>): Entry {
  const runs = k.s.groupId ? groups.get(`${k.s.groupId}${k.s.archived ? ':a' : ''}`) : undefined;
  if (!runs || runs.length < 2) return { kind: 'task', key: k.key, s: k.s };
  return { kind: 'group', key: `g:${k.s.groupId}${k.s.archived ? ':a' : ''}`, runs, state: groupState(runs), updatedAt: Math.max(...runs.map((r) => r.s.updatedAt)) };
}

/** What the sort keys read off an entry: a group reads as its first run, with its own state. */
const lead = (e: Entry): SessionRow | undefined => (e.kind === 'task' ? e.s : e.kind === 'group' ? e.runs[0]?.s : undefined);
const stateOf = (e: Entry): Session['state'] | undefined => (e.kind === 'group' ? e.state : lead(e)?.state);
const updatedOf = (e: Entry): number => (e.kind === 'group' ? e.updatedAt : (lead(e)?.updatedAt ?? 0));
const createdOf = (e: Entry): number => (e.kind === 'group' ? Math.min(...e.runs.map((r) => r.s.createdAt)) : (lead(e)?.createdAt ?? 0));

function visibleEntries(all: readonly Keyed[], f: Filter): Entry[] {
  const groups = runsByGroup(all);
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const k of all) {
    const s = k.s;
    if (!inProject(s, f.project)) continue;
    const mine = f.crew !== undefined && s.crew?.id === f.crew;
    if (f.crew !== undefined && !mine) continue;
    // a crew job for another task lives under its member, unless it needs you
    if (f.underMember?.(s) && !needsYou(s) && !mine) continue;
    if (s.parentId) continue; // a subagent: under its lead (rows.ts nests the open one)
    const e = entryOf(k, groups);
    if (e.kind === 'group') {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
    }
    out.push(e);
  }
  return out;
}

const forLaterAt = (e: Entry): number => lead(e)?.forLater?.at ?? 0;
const everyRun = (e: Entry, p: (s: SessionRow) => boolean): boolean => (e.kind === 'group' ? e.runs.every((r) => p(r.s)) : !!lead(e) && p(lead(e) as SessionRow));
const anyRun = (e: Entry, p: (s: SessionRow) => boolean): boolean => (e.kind === 'group' ? e.runs.some((r) => p(r.s)) : !!lead(e) && p(lead(e) as SessionRow));

/** Every task by section, each in v1's order. Plans and drafts come from `plans`. */
export function sections(all: readonly Keyed[], f: Filter = ALL, plans: readonly Row<Plan>[] = []): Sections {
  const every = visibleEntries(all, f);
  const archived = (e: Entry): boolean => !!lead(e)?.archived;
  const forLater = every.filter((e) => everyRun(e, isForLater)).sort((a, b) => forLaterAt(b) - forLaterAt(a));
  const live = every.filter((e) => !archived(e) && !everyRun(e, isForLater));
  const scheduled = (e: Entry): boolean => e.kind === 'task' && isScheduled(e.s);
  const term = (e: Entry): boolean => e.kind === 'task' && inTerm(e.s);
  // Needs you: asking first, then the latest
  const needs = live
    .filter((e) => (stateOf(e) === 'review' || stateOf(e) === 'waiting') && !term(e) && !scheduled(e))
    .sort((a, b) => Number(stateOf(b) === 'waiting') - Number(stateOf(a) === 'waiting') || updatedOf(b) - updatedOf(a));
  // Working keeps launch order, so the list doesn't reshuffle on every tool call
  const working = live.filter((e) => stateOf(e) === 'running' || term(e)).sort((a, b) => createdOf(b) - createdOf(a));
  const plansIn = (kind: 'drafts' | 'scheduled'): Entry[] =>
    f.crew !== undefined ? [] : plans.filter((p) => (kind === 'drafts') === (p.kind === 'draft') && inProject(p as SessionRow, f.project)).map((plan) => ({ kind: 'plan', key: `p:${plan.id}`, plan }));
  const atOf = (e: Entry): number => (e.kind === 'plan' ? e.plan.at : e.kind === 'task' ? nextAt(e.s) : Infinity);
  const sched = [...live.filter(scheduled), ...plansIn('scheduled')].sort((a, b) => atOf(a) - atOf(b));
  const drafts = plansIn('drafts').sort((a, b) => (b.kind === 'plan' ? b.plan.at : 0) - (a.kind === 'plan' ? a.plan.at : 0));
  const done = live.filter((e) => stateOf(e) === 'done' && !scheduled(e)).sort((a, b) => updatedOf(b) - updatedOf(a));
  const arch = every.filter(archived).sort((a, b) => updatedOf(b) - updatedOf(a));
  return { needs, working, scheduled: sched, drafts, forLater, done, archived: arch };
}

/** For later's heading says what a crew member filed there unread: nothing pings for it. */
export const freshForLater = (list: readonly Entry[]): number => list.filter((e) => anyRun(e, (s) => !!s.unread && s.forLater?.by === 'crew')).length;

/** Every key the sections show, for pruning what's gone. */
export function keysShown(sec: Sections): Set<string> {
  const out = new Set<string>();
  for (const id of SECTION_IDS) for (const e of sec[id]) out.add(e.key);
  return out;
}
