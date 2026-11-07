// @wisp-plugin/later-api: the contract of wisp.later, the work wisp does at a time you or an agent
// set (v1 server/later.js, design/later.md). Three kinds:
//   follow-up  an entry on a task, sent into that same task when due, so its agent carries on with its
//              whole conversation (the agent's resume_later, or Send later in the reply box)
//   reminder   an entry with remind: true brings that task back to Needs you with its text; a plan
//              { kind: 'reminder' } becomes a small task of its own, with no agent
//   task       a plan { kind: 'task', body }: a launch, started when due (or a draft with no time, or
//              one that waits for another task to be done: /draft, /after)
// Entries and plans are rows (later_entry, later_plan); a task's entries are mirrored into its ext
// slot `ext['wisp.later']` (LaterExt) for the list row. The pure helpers below are v1's exports.

import type { Json } from '@wisp/kernel';
import type { Attachment, SessionId } from '@wisp-plugin/runtime-api';

export const PLUGIN_ID = 'wisp.later';

export const MIN_MS = 60_000;
export const MAX_MS = 30 * 24 * 3600_000; // a month: yours
export const AGENT_MAX_MS = 7 * 24 * 3600_000; // an agent's own wake-ups
export const PER_TASK = 5; // pending on one task
export const CHAIN_MAX = 10; // an agent's wake-ups in a row with no word from you
export const LATE_MS = 2 * 60_000; // later than this: the agent is told it's late
export const MISSED_MS = 24 * 3600_000; // later than this: you decide, it doesn't just run
export const TEXT_MAX = 4000;

/**
 * The follow-up that carries a task on after a usage limit: the limit card's Wait until, and wisp's
 * own with Settings → Wait for the reset (`limitWait`) on. The page knows the card was answered by this text.
 */
export const LIMIT_CARRY_ON = 'Carry on from where the last run stopped at the usage limit.';

// ---------- shapes ----------

/** Automations stop at moved it to the reset (the page says Waits for your plan). load: the machine's, not the plan's. */
export interface LaterHeld {
  why: string;
  until: number;
  load?: true;
}

/** Who scheduled it: 'user', 'agent', a crew member's name, or 'wisp' (a goal round, the carry-on at a limit). */
export interface LaterEntry {
  id: string;
  sessionId: SessionId;
  at: number;
  text: string;
  by: string;
  setAt: number;
  remind?: true;
  /** the goal round it starts (by 'wisp': a round that waits for the plan) */
  goal?: number;
  held?: LaterHeld;
  /** the plan it waits on at a usage limit, so an early reset of that one sends it sooner */
  limit?: { agent: string; account: string };
  attachments?: Attachment[];
}

/** What the page and other machines see of a task's follow-ups (v1 laterView). */
export interface LaterView {
  id: string;
  at: number;
  text: string;
  by: string;
  setAt: number;
  remind?: true;
  files?: number;
  held?: LaterHeld;
  goal?: number;
}

/** A reminder that came due on a task (v1 `session.reminder`). was: the state it goes back to on snooze. */
export interface Reminder {
  text: string;
  at: number;
  setAt: number;
  by: string;
  was?: string;
  from?: { id: string; title: string };
  missed?: true;
}

/** Parked to look at again (design/for-later.md). */
export interface ForLater {
  at: number;
  by: string;
}

/** Who scheduled the follow-up a turn carries and when (v1 `turn.later`): the note the agent reads. */
export interface SentMeta {
  by: string;
  setAt: number;
  at: number;
  late?: true;
}

/** `session.ext['wisp.later']`, written only by wisp.later. */
export interface LaterExt {
  later?: LaterView[];
  forLater?: ForLater;
  reminder?: Reminder;
  /** a reminder of its own: a finished task with no agent to talk to */
  kind?: 'reminder';
  /** a task a plan started */
  origin?: { kind: 'later'; id: string; name: string };
  /** the follow-up being sent now; moved onto the turn it starts (`turn.ext['wisp.later']`) */
  sent?: SentMeta;
}

/** A launch body (runtime StartArgs) kept by a task plan. */
export interface PlanBody {
  prompt: string;
  [k: string]: Json | undefined;
}

export interface Plan {
  id: string;
  kind: 'task' | 'reminder';
  setAt: number;
  at?: number;
  /** /draft: no time, waits in Drafts until you start it */
  draft?: true;
  /** /after: starts once that task is done */
  after?: { id: string; title: string };
  /** it waited for a task that went (deleted) or was put away (archived): a draft now */
  lost?: { id: string; title: string; why: 'deleted' | 'archived' };
  body?: PlanBody;
  title?: string;
  text?: string;
  from?: { id: string; title: string };
}

// ---------- commands (permission `later:<verb>`) ----------

export const COMMANDS = {
  add: 'later.add', // { sessionId, text, at? | in?, remind?, by?, attachments?, goal?, held?, limit? } → LaterEntry
  edit: 'later.edit', // { sessionId, item, at? | in?, text?, now? } → LaterEntry | fire result   (item 'reminder' snoozes)
  cancel: 'later.cancel', // { sessionId, item? , goalRound? } → { ok, entry? }   (goalRound: the goal takes its own waiting round back, no event)
  done: 'later.done', // { sessionId } → {}   (Mark done: the agent's own wake-ups go, yours stay)
  park: 'later.park', // { sessionId, forLater, state?, by? } → { forLater? }   (For later: PATCH /sessions/:id)
  list: 'later.list', // { sessionId } → LaterEntry[]  (read-only)
  plans: 'later.plans', // {} → Plan[]  (read-only)
  plan: 'later.plan', // { kind, at? | in?, draft?, after?, body? | text?, from? } → Plan
  getPlan: 'later.getPlan', // { id } → Plan  (read-only)
  editPlan: 'later.editPlan', // { id, at? | in?, text?, prompt?, now? } → Plan | { session }
  cancelPlan: 'later.cancelPlan', // { id } → { ok }
  waitAtLimit: 'later.waitAtLimit', // { sessionId, at } → LaterEntry | null   (v1 runner.waitAtLimit, for the runtime)
  nextAt: 'later.nextAt', // {} → { at: number | null }  (read-only; GET /api/status nextWakeAt)
  tick: 'later.tick', // {} → { fired }   (look now: what is due goes)
  agentSchedule: 'later.agent.schedule', // the resume_later MCP tool: { session, minutes? | at?, message?, cancel? } → { text } | { error }
} as const;

export const EVENTS = {
  added: 'later.added', // { sessionId, entry: LaterView }   (v1 telemetry resume_later, and the agent's own)
  fired: 'later.fired', // { sessionId, entryId, by, remind }   (a follow-up or reminder went)
  /** an entry wisp scheduled went without being sent: 'cancelled' by you, or the task was marked 'done' */
  dropped: 'later.dropped', // { sessionId, entry: LaterView, why: 'cancelled' | 'done' }
  planStarted: 'later.planStarted', // { planId, sessionId, kind }
} as const;

// ---------- pure helpers (v1 exports) ----------

export class LaterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const bad = (message: string, code = 'invalid'): LaterError => new LaterError(code, message);

/** `{ at }` or `{ in: minutes }` → a time from now, checked against the limits. */
export function whenOf(body: { at?: unknown; in?: unknown }, o: { now: number; max?: number }): number {
  const max = o.max ?? MAX_MS;
  let at: unknown = body.at;
  if (typeof at === 'string' && at.trim()) at = Date.parse(at);
  if (at === undefined || at === null || at === '') at = body.in !== undefined ? o.now + Number(body.in) * 60_000 : NaN;
  if (typeof at !== 'number' || !Number.isFinite(at)) throw bad('Say when: at (a time) or in (minutes).');
  const t = Math.round(at);
  if (t < o.now + MIN_MS - 1000) throw bad('Pick a time at least a minute from now.');
  if (t > o.now + max) throw bad(`Pick a time within ${max === MAX_MS ? 'a month' : 'a week'}.`);
  return t;
}

/** The text of an entry or plan: trimmed, required, at most 4000 characters. */
export function textOf(t: unknown, what = 'text'): string {
  const s = String(t ?? '').trim();
  if (!s) throw bad(`${what} required`);
  return s.slice(0, TEXT_MAX);
}

/** "14:32" today, "yesterday 14:32", "Mon 14:32" further: in what wisp writes on a reminder. */
export function clock(t: number, now: number): string {
  const d = new Date(t);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x: number): string => new Date(x).toDateString();
  if (day(t) === day(now)) return hm;
  if (day(t) === day(now - 86400_000)) return `yesterday ${hm}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

export const titleOf = (prompt: string): string => (prompt.split('\n')[0] ?? '').slice(0, 80);

export function laterView(l: LaterEntry): LaterView {
  return {
    id: l.id, at: l.at, text: l.text, by: l.by, setAt: l.setAt,
    ...(l.remind && { remind: true as const }), ...(l.attachments?.length && { files: l.attachments.length }), ...(l.held && { held: l.held }), ...(l.goal !== undefined && { goal: l.goal }),
  };
}

/** The note the agent reads ahead of a follow-up it (or you) scheduled. The bubble shows only the text. */
export function laterNote(l: SentMeta, now: number): string {
  const t = (x: number): string => clock(x, now);
  const who = l.by === 'agent' ? 'you' : l.by === 'user' ? 'the user' : l.by;
  const late = l.late ? ` It was due at ${t(l.at)} but wisp wasn't running then, so it's ${Math.round((now - l.at) / 60_000)} min late: check the current state before you act on anything you saw before.` : '';
  return `(wisp: this is the follow-up ${who} scheduled at ${t(l.setAt)} for ${t(l.at)}. Carry on from where this conversation left off.${late})`;
}

/** Plans with no time (drafts, /after) sort after the timed ones, oldest first. */
export const byTime = (a: Plan, b: Plan): number => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.setAt - b.setAt;
