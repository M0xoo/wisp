// @wisp-plugin/goal-api: the contract of wisp.goal (v1 server/goal.js, goal-runs.js, design/goals.md).
// A task with a goal keeps going until its condition holds: after each round (a turn) wisp checks the
// work with a read-only run of a cheap model (runtime.quick), or of its judges (harnesses, or crew
// members on theirs), voting by `vote`. While it isn't met, the task goes back to its agent with what's
// missing. It lands once the goal is met, can't be met, or goes in circles.
//
// The goal lives in the session's ext slot `ext['wisp.goal']` (Goal) and reaches the list row as the
// `goal` summary field (GoalView). What each check said and did is a row (goal_run), never a task.
// The pure helpers are v1's exports, so the runtime (/goal in a reply) and the UI read the same rules.

import type { SessionId } from '@wisp-plugin/runtime-api';

export const PLUGIN_ID = 'wisp.goal';
export const MAX_TEXT = 1000;
export const MAX_JUDGES = 5;
export const MAX_CHECKS = 50;
/** This many rounds in a row that changed nothing, or were told the same next step: it's stuck. */
export const STALL = 2;
export const OWN_CHECK = 'wisp’s check';

/** working (the agent is on a round) · checking · met · impossible · paused · out (old goals: ran out of rounds) · handed (Auto moved it) */
export type GoalStatus = 'working' | 'checking' | 'met' | 'impossible' | 'paused' | 'out' | 'handed';
export type Verdict = 'met' | 'not_yet' | 'impossible' | 'unchecked';
export type Vote = 'all' | 'majority' | 'any';

export const ENDED: ReadonlySet<string> = new Set(['met', 'impossible', 'out', 'handed']);
/** How the judges' votes add up to "met". Can't be done always takes a majority of them. */
export const VOTES: Readonly<Record<Vote, string>> = { all: 'All', majority: 'Majority', any: 'Any' };
export const majorityOf = (n: number): number => Math.floor(n / 2) + 1;
export const votesNeeded = (vote: Vote | undefined, n: number): number => (vote === 'all' ? n : vote === 'any' ? 1 : majorityOf(n));

/** A harness with its model and thinking level, or a crew member (who brings theirs). */
export type Judge = { agent: string; model: string; effort: string; name?: string } | { crew: string; name?: string };

export interface TestsResult {
  verdict: 'pass' | 'fail' | 'unknown' | 'skip';
  command: string | null;
}

export interface JudgeVote {
  name: string;
  agent?: string;
  model?: string;
  crew?: string;
  verdict: Verdict;
  why: string;
  next?: string;
  progress?: number | null;
  run?: string;
}

export interface GoalCheck {
  turnId: string;
  round: number;
  at: number;
  verdict: Verdict;
  why: string;
  next?: string;
  progress?: number | null;
  tests?: TestsResult;
  tally?: string;
  votes?: JudgeVote[];
  /** the bench that cast the votes: they count only while it judges */
  bench?: number;
  /** the record of wisp's own check (goal-run id) */
  run?: string;
  /** files the round changed */
  changed: number;
}

export interface RunningCheck {
  run: string;
  name: string;
  at: number;
  agent?: string;
  model?: string;
  crew?: string;
}

/** `session.ext['wisp.goal']`, written only by wisp.goal. */
export interface Goal {
  text: string;
  round: number;
  status: GoalStatus;
  setAt: number;
  endedAt?: number;
  why?: string;
  by?: string;
  checks: GoalCheck[];
  /** where the checks that count toward a stall start (set on Resume) */
  fresh?: number;
  judges?: Judge[];
  vote?: Vote;
  /** bumped each time the judges change */
  bench?: number;
  /** the check's runs under way, while it's checking */
  running?: RunningCheck[];
  /** the reset a paused goal's next round waits for (Automations stop at); the round is a later entry */
  held?: number;
  /** the turn its changes are measured from */
  from?: string;
}

/** The goal on a summary: what the row, the band and the details need. */
export interface GoalView {
  text: string;
  judges?: Judge[];
  vote?: Vote;
  status: GoalStatus;
  round: number;
  why?: string;
  held?: number;
  setAt: number;
  endedAt?: number;
  checks: Omit<GoalCheck, 'turnId' | 'votes' | 'bench' | 'changed'>[];
  running?: RunningCheck[];
  last?: { verdict: Verdict; why: string; tally?: string; votes?: Pick<JudgeVote, 'name' | 'verdict' | 'why' | 'run'>[] };
}

/** One step of a check's run, as a task turn's activity holds it. */
export type RunStep = Record<string, unknown>;

/** What one goal check said and did (v1 goal-runs/<task>/<run>.json → a goal_run row). */
export interface GoalRun {
  id: string;
  task: SessionId;
  turnId: string;
  round: number;
  name: string;
  agent?: string;
  model?: string;
  effort?: string;
  crew?: string;
  /** running · done · stopped · error */
  status: 'running' | 'done' | 'stopped' | 'error';
  /** how a run with no verdict ended: timeout · stopped · error · nojson · interrupted (wisp restarted) */
  end?: 'timeout' | 'stopped' | 'error' | 'nojson' | 'interrupted';
  verdict?: Verdict;
  why?: string;
  next?: string;
  progress?: number;
  evidence?: string[];
  turn: { id: string; prompt: string; status: string; startedAt: number; endedAt?: number; activity: RunStep[]; raw: string; trimmed?: number };
}

// ---------- commands (permission `goal:<verb>`) ----------

export const COMMANDS = {
  set: 'goal.set', // { sessionId, goal: string | { text, judges?, vote? }, kick? } → GoalView   (PUT /sessions/:id/goal; /goal in a reply)
  pause: 'goal.pause', // { sessionId, why? } → GoalView
  resume: 'goal.resume', // { sessionId } → GoalView
  drop: 'goal.drop', // { sessionId } → { dropped: boolean }
  get: 'goal.get', // { sessionId } → GoalView | null  (read-only)
  runs: 'goal.runs', // { sessionId } → GoalRun[] without their turns  (read-only)
  run: 'goal.run', // { sessionId, run } → GoalRun  (read-only; not_found: "That check isn’t kept any more.")
  carryOn: 'goal.carryOn', // { sessionId, entry: { text, goal } } → follow-up result | null   (a round that waited for the plan comes due)
  check: 'goal.check', // { sessionId } → {}   (check now: a task whose turn ended, if its goal is working)
} as const;

export const EVENTS = {
  /** v1 telemetry goal_ended */
  ended: 'goal.ended', // { sessionId, status, rounds }
  checked: 'goal.checked', // { sessionId, round, verdict }
  /** a check's record changed (v1 broadcast 'goal-run'): its row is on the session topic too */
  run: 'goal.run', // { sessionId, run, done? }
} as const;

// ---------- pure helpers ----------

export class GoalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const bad = (message: string, code = 'invalid'): GoalError => new GoalError(code, message);

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const GOAL_CMD = /^\/goal(?:\s+|$)/i;
/** The condition in "/goal all tests pass" ('' for a bare /goal), or null when the text isn't one. */
export function goalCommand(text: unknown): string | null {
  const t = String(text ?? '').trim();
  return GOAL_CMD.test(t) ? t.replace(GOAL_CMD, '').trim() : null;
}

/** "/goal drop" (clear, off, none) */
export const dropsGoal = (condition: string): boolean => /^(drop|clear|off|none)$/i.test(condition);

export interface NormalGoal {
  text: string;
  judges?: Judge[];
  vote?: Vote;
}

/**
 * { text, judges?, vote? } from a request body, or null for none. Throws on a bad one. judges is left out
 * when the body doesn't say (an edit keeps the ones it had); [] clears them. An old client's `max` is
 * ignored. `known` says which harnesses wisp has (all, when it can't tell).
 */
export function normalizeGoal(g: unknown, known?: readonly string[]): NormalGoal | null {
  if (g === null || g === undefined || g === false) return null;
  const o = typeof g === 'object' ? (g as Record<string, unknown>) : undefined;
  const text = String(typeof g === 'string' ? g : (o?.['text'] ?? '')).trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) throw bad(`A goal is at most ${MAX_TEXT} characters.`);
  const out: NormalGoal = { text };
  if (o && o['judges'] !== null && o['judges'] !== undefined) out.judges = normalizeJudges(o['judges'], known);
  if (o && o['vote'] !== null && o['vote'] !== undefined) {
    const v = o['vote'];
    if (typeof v !== 'string' || !Object.hasOwn(VOTES, v)) throw bad(`vote must be one of ${Object.keys(VOTES).join(', ')}.`);
    out.vote = v as Vote;
  }
  return out;
}

export function normalizeJudges(list: unknown, known?: readonly string[]): Judge[] {
  if (!Array.isArray(list)) throw bad('judges must be a list.');
  if (list.length > MAX_JUDGES) throw bad(`A goal has at most ${MAX_JUDGES} judges.`);
  return list.map((j: unknown): Judge => {
    if (!j || typeof j !== 'object') throw bad('Each judge is { agent, model, effort } or { crew }.');
    const r = j as Record<string, unknown>;
    const name = clip(String(r['name'] ?? '').replace(/\s+/g, ' ').trim(), 40);
    if (r['crew']) return { crew: String(r['crew']).slice(0, 64), ...(name && { name }) };
    const agent = String(r['agent'] ?? '');
    if (!agent || (known && !known.includes(agent))) throw bad(`A judge needs a harness wisp knows (${(known ?? []).join(', ')}), not “${agent || 'none'}”.`);
    return { agent, model: String(r['model'] ?? '').slice(0, 120), effort: String(r['effort'] ?? '').slice(0, 20), ...(name && { name }) };
  });
}

/**
 * Keep the judges on the goal only when there are some; the vote only with them. Different judges (or
 * another rule) start the stall count over and set the old votes aside. Changes `goal` and returns it.
 */
export function withJudges(goal: Goal, judges: Judge[] | undefined, vote: Vote | undefined): Goal {
  const was = JSON.stringify([goal.judges ?? [], goal.judges ? goal.vote : null]);
  delete goal.judges;
  delete goal.vote;
  if (judges?.length) Object.assign(goal, { judges, vote: vote ?? 'majority' });
  if (JSON.stringify([goal.judges ?? [], goal.judges ? goal.vote : null]) !== was && goal.checks.length) Object.assign(goal, { bench: (goal.bench ?? 0) + 1, fresh: goal.checks.length });
  return goal;
}

/** What the agent hears about its goal, every turn. */
export function goalNote(g: Goal | undefined): string {
  if (!g || ENDED.has(g.status)) return '';
  return `\n\n## Goal\n\nThis task has a goal. It is done only when this is true:\n\n> ${g.text.replace(/\n/g, '\n> ')}\n\nAfter each of your turns wisp checks your work against it, independently, by reading the files (it doesn't take your word for it). While it isn't met, the task comes back to you with what's missing (round ${g.round} now). Work until it is met, and verify it yourself before you finish. If it can't be met (it needs access you don't have, contradicts itself, or only the user can do part of it), stop trying and say exactly why in your report, with the hero's status "blocked".`;
}

/** The goal on a summary: the last 50 checks without their votes; the last one's votes while their bench judges. */
export function goalView(g: Goal | undefined): GoalView | undefined {
  if (!g) return undefined;
  const last = g.checks.at(-1);
  const checks = g.checks.slice(-MAX_CHECKS).map(({ round, verdict, why, next, progress, at, tests, tally, run }) => ({
    round, verdict, why, ...(next && { next }), ...(progress !== null && progress !== undefined && { progress }), ...(tests && { tests }), ...(tally && { tally }), ...(run && { run }), at,
  }));
  const votes = last?.votes && (last.bench ?? 0) === (g.bench ?? 0) ? last.votes.map(({ name, verdict, why, run }) => ({ name, verdict, why, ...(run && { run }) })) : undefined;
  return {
    text: g.text, ...(g.judges && { judges: g.judges, vote: g.vote ?? 'majority' }), status: g.status, round: g.round, ...(g.why && { why: g.why }), ...(g.held && { held: g.held }),
    setAt: g.setAt, ...(g.endedAt && { endedAt: g.endedAt }), checks, ...(g.status === 'checking' && g.running?.length && { running: g.running }),
    ...(last && { last: { verdict: last.verdict, why: last.why, ...(last.tally && { tally: last.tally }), ...(votes && { votes }) } }),
  };
}

/** The runs a goal's checks point at. */
export const refsOf = (g: Goal | undefined): string[] => (g?.checks ?? []).flatMap((c) => [c.run, ...(c.votes ?? []).map((v) => v.run)]).filter((x): x is string => !!x);

/** Rounds that changed nothing, or were sent back with the same next step and no more progress: going in circles. */
export function stalled(g: Goal): boolean {
  const tail = g.checks.slice(g.fresh ?? 0).slice(-STALL);
  if (tail.length < STALL || !tail.every((c) => c.verdict === 'not_yet')) return false;
  const flat = tail.every((c, i) => !i || (c.progress ?? 0) <= (tail[i - 1]?.progress ?? 0));
  return tail.every((c) => !c.changed) || (!!tail[0]?.next && flat && tail.every((c) => c.next === tail[0]?.next));
}
