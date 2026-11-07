// Ported from the TypeScript reference (git show v2-ts-server-reference:plugins/crew/api/src/). Pure.
// Where a crew job sits in the task list (v1 web/js/features/crew.js and the crew rules of feed.js
// groups()/reveal()), and the rail's pick: pure, over plain rows, so the page and its tests read the
// same rules. A job run for another task (delegated, an @mention, a check on it) lives under its
// member until it needs you; then it is in Needs you with your own tasks, and only there. The rest
// (check-ins, jobs you sent, triggers) are tasks in the list like any other.
import type { JobLike } from './jobs.ts';
import { byUrgency, jobMark, standing } from './jobs.ts';
import { crewMentions, mentionOf } from './mentions.ts';
import type { Named } from './mentions.ts';

export interface FeedRow extends JobLike {
  title?: string;
  createdAt?: number;
  crew?: { id: string; job: string; from?: { id: string; title?: string } };
  forLater?: { at: number; by?: string };
  later?: readonly { at: number; remind?: boolean }[];
  reminder?: unknown;
  held?: { waiting?: unknown } | null;
  tui?: boolean;
  term?: unknown;
  projectId?: string;
  also?: readonly { projectId?: string }[];
  parentId?: string;
}

/** The jobs that are for another task: they sit under their member. */
export const FOR_TASK: ReadonlySet<string> = new Set(['delegated', 'mention', 'event']);

// v1 web/js/core/state.js: the list's own rules, which the crew's placement reads.
export const isForLater = (s: FeedRow | undefined): boolean => !!s?.forLater && !s.archived && !s.reminder && !s.pending && (s.state === 'review' || s.state === 'done');
export const isScheduled = (s: FeedRow | undefined): boolean =>
  !!s && !s.archived && !s.forLater &&
  ((s.state === 'done' && (!!s.later?.length || !!s.held?.waiting)) ||
    (s.state === 'review' && !s.reminder && !s.held && !s.pending && !(s.tui && s.term) && !!s.later?.some((l) => !l.remind)));
/** Asking you, or a report you haven't read (the tab title, the crew's dots and home count it). */
export const needsYou = (s: FeedRow): boolean => !isForLater(s) && !s.archived && !isScheduled(s) && (s.state === 'waiting' || (s.state === 'review' && !!s.unread));
export const inProject = (s: FeedRow, id: string): boolean => s.projectId === id || !!s.also?.some((a) => a.projectId === id);

/** A crew job for another task, whose member is still on the crew, and not saved for later. */
export const underMember = (s: FeedRow | undefined, has: (crewId: string) => boolean): boolean => !!s?.crew && FOR_TASK.has(s.crew.job) && has(s.crew.id) && !isForLater(s);

/**
 * Needs you, with a memory: a report opened from Needs you keeps its row there until it closes, even
 * once it's read. One per page; `open` is what the page has open.
 */
export class NeedsTracker {
  readonly #now = new Set<string>();
  inNeeds(s: FeedRow, o: { open: ReadonlySet<string>; has: (crewId: string) => boolean }): boolean {
    if (!underMember(s, o.has) || s.pending) return false;
    if (needsYou(s)) this.#now.add(s.id);
    else if (!o.open.has(s.id) || !needsYou({ ...s, unread: true })) this.#now.delete(s.id);
    return this.#now.has(s.id);
  }
}

/** What the list reads of the page: the filter, the pick, what's open, which members exist. */
export interface FeedCtx {
  filter: string; // a project id, or 'all'
  pick: string | null;
  open: ReadonlySet<string>;
  has: (crewId: string) => boolean;
  needs: NeedsTracker;
}

/** In the list (Needs you, or its member's pick) right now: a project filter leaves it under its member. */
export function inList(s: FeedRow, c: FeedCtx): boolean {
  const need = c.needs.inNeeds(s, c); // first: it keeps count of what's open
  return (c.pick ? s.crew?.id === c.pick : need) && (c.filter === 'all' || inProject(s, c.filter));
}

/** Whether the list shows the row at all (v1 groups()'s crew and subagent rules). */
export function listed(s: FeedRow, c: Pick<FeedCtx, 'pick' | 'open' | 'has' | 'needs'>): boolean {
  const mine = !!c.pick && s.crew?.id === c.pick;
  if (c.pick && !mine) return false;
  if (underMember(s, c.has) && !c.needs.inNeeds(s, c) && !mine) return false;
  return !s.parentId; // a subagent opened by itself sits under its lead
}

export interface Sections<R> {
  needs: R[];
  working: R[];
  scheduled: R[];
  forLater: R[];
  done: R[];
  archived: R[];
}

/** v1 feed.js groups(): every task by section, in its order (compare groups aside: the feed's own). */
export function sections<R extends FeedRow>(rows: Iterable<R>, c: FeedCtx): Sections<R> {
  const every = [...rows].filter((s) => (c.filter === 'all' || inProject(s, c.filter)) && listed(s, c));
  const at = (s: R): number => s.updatedAt ?? 0;
  const forLater = every.filter(isForLater).sort((a, b) => (b.forLater?.at ?? 0) - (a.forLater?.at ?? 0));
  const all = every.filter((s) => !s.archived && !isForLater(s));
  const inTerm = (s: R): boolean => !!s.tui && !!s.term && s.state === 'review';
  const needs = all.filter((s) => (s.state === 'review' || s.state === 'waiting') && !inTerm(s) && !isScheduled(s)).sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || at(b) - at(a));
  const working = all.filter((s) => s.state === 'running' || inTerm(s)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const scheduled = all.filter(isScheduled);
  const done = all.filter((s) => s.state === 'done' && !isScheduled(s)).sort((a, b) => at(b) - at(a));
  const archived = every.filter((s) => s.archived).sort((a, b) => at(b) - at(a));
  return { needs, working, scheduled, forLater, done, archived };
}

export interface MemberState<R> {
  jobs: R[];
  /** jobs sent that haven't started yet (a Starting up card) */
  sent: R[];
  asks: boolean;
  live: R[];
  unread: number;
  mood: 'asks' | 'live' | 'sleep' | 'idle';
}

/** What a member is up to, from its jobs in the list. */
export function memberState<R extends FeedRow>(m: { id: string; paused?: boolean }, rows: Iterable<R>): MemberState<R> {
  const mine = [...rows].filter((s) => s.crew?.id === m.id);
  const jobs = mine.filter((s) => !s.pending);
  const sent = mine.filter((s) => s.pending);
  const asks = jobs.some((s) => s.state === 'waiting');
  const live = [...jobs.filter((s) => s.state === 'running'), ...sent];
  const unread = jobs.filter((s) => s.state === 'review' && needsYou(s)).length; // saved for later or scheduled: not a ping
  return { jobs, sent, asks, live, unread, mood: asks ? 'asks' : live.length ? 'live' : m.paused ? 'sleep' : 'idle' };
}

/** How many jobs sit under a member in the section (an open one also keeps every live job). */
export const JOBS_MAX = 3;

/**
 * A member's jobs under it (the ones for another task), most urgent first. Ones you marked done or
 * archived are only in its thread. `crewOpen`: the member whose thread is open; `pinned`: jobs opened
 * from a link or a toast, shown under their member until closed.
 */
export function memberJobs<R extends FeedRow>(m: { id: string }, st: MemberState<R>, c: FeedCtx & { crewOpen: string | null; pinned: ReadonlySet<string> }, max = JOBS_MAX): { list: R[]; more: number } {
  const kept = (s: R): boolean => c.open.has(s.id) || c.pinned.has(s.id);
  const list = st.jobs.filter((s) => underMember(s, c.has) && !inList(s, c) && (standing(s) || kept(s))).sort(byUrgency);
  const open = c.crewOpen === m.id;
  const keep = list.filter((s, i) => i < max || (open && !!jobMark(s)) || kept(s));
  return { list: keep, more: list.length - keep.length };
}

// ---------- the rail's pick ----------

/** Where the page keeps the pick (local storage key). */
export const PICK_KEY = 'wisp.crewPick';

/**
 * The member picked on the rail, as it applies: only with the rail on. Until the crew is known
 * (`members` undefined) it holds, so a reload doesn't flash the whole list; a removed member is All.
 */
export function crewPick(saved: string | null, o: { railOn: boolean; members: readonly Named[] | undefined }): string | null {
  if (!saved || !o.railOn) return null;
  return !o.members || o.members.some((m) => m.id === saved) ? saved : null;
}
export const inPick = (s: FeedRow | undefined, pick: string | null): boolean => !pick || s?.crew?.id === pick;

/** Opening a task: a pick that hides it goes (a subagent goes with its lead). */
export const pickAfterOpen = (pick: string | null, s: FeedRow, lead?: FeedRow): string | null => (inPick((s.parentId && lead) || s, pick) ? pick : null);
/** Another member's thread clears the pick; its own keeps it. */
export const pickAfterThread = (pick: string | null, memberId: string): string | null => (pick && pick !== memberId ? null : pick);
/** The face toggles its member; the hover card's head and last row only ever pick. */
export const pickFace = (pick: string | null, memberId: string): string | null => (pick === memberId ? null : memberId);
export const pickCard = (_pick: string | null, memberId: string): string => memberId;

/** Where reveal() lands for a row: under its member (Crew), or the section the list has it in. */
export function revealSection(s: FeedRow, c: FeedCtx): 'secCrew' | 'secNeeds' | 'secWorking' | 'secScheduled' | 'secForLater' | 'secDone' | 'secArchived' {
  if (underMember(s, c.has) && !c.needs.inNeeds(s, c) && !c.pick) return 'secCrew';
  const g = sections([s], { ...c, filter: 'all' });
  if (g.needs.length) return 'secNeeds';
  if (g.working.length) return 'secWorking';
  if (g.scheduled.length) return 'secScheduled';
  if (g.forLater.length) return 'secForLater';
  return g.archived.length ? 'secArchived' : 'secDone';
}

/** The members a message starts with: it's for them, not for the task's agent. rest: the message without them. */
export function addressedTo<M extends Named>(text: unknown, members: readonly M[]): { members: M[]; rest: string } {
  const t = crewMentions(String(text ?? '').trimStart(), members);
  return { members: t.lead, rest: t.lead.length ? t.rest : String(text ?? '').trim() };
}

/**
 * New task with a member picked on the rail: what goes out is `@Ada …`, as the @ picker writes it.
 * A typed @Other wins, and a slash command isn't a job: null, it goes as typed.
 */
export function pickedPrompt<M extends Named>(text: unknown, m: M | null, members: readonly M[]): string | null {
  const t = String(text ?? '').trim();
  if (!m || t.startsWith('/') || addressedTo(t, members).members.length) return null;
  return `${mentionOf(m)} ${t}`;
}
