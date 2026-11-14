// The goal's rules as the UI reads them (v1 web/js/features/goal.js and judges.js), pure: what the
// band, the row, the checks and the editors show for a goal. Words come back as i18n keys with their
// vars, so these stay testable without a catalogue.

import type { CheckView, GoalStatus, GoalView, HarnessRow, Judge, JudgeVote, MemberRow, SessionRow, Verdict, Vote } from './types.ts';
import { STALL } from './types.ts';
import { t, type Key, type Vars } from './i18n.ts';

export interface Words {
  readonly key: Key;
  readonly vars?: Vars;
}

const LIVE: ReadonlySet<GoalStatus> = new Set(['working', 'checking']);
const ENDED: ReadonlySet<GoalStatus> = new Set(['met', 'impossible', 'out', 'handed']);

/** The agent is on a round, or wisp is checking one. */
export const goalLive = (g: GoalView | undefined): boolean => !!g && LIVE.has(g.status);
/** Not ended: the reply box's button edits it rather than starting a new one. */
export const goingOn = (g: GoalView | undefined): boolean => !!g && !ENDED.has(g.status);

export const majorityOf = (n: number): number => Math.floor(n / 2) + 1;
export const votesNeeded = (vote: Vote | undefined, n: number): number => (vote === 'all' ? n : vote === 'any' ? 1 : majorityOf(n));

/** "2 of 3 must say it's met": the rule in words, for the editor and the tooltips. */
export function ruleLine(vote: Vote | undefined, n: number): Words | undefined {
  if (n <= 0) return undefined;
  if (n === 1) return { key: 'wisp.goal.rule.one' };
  if (vote === 'all') return { key: 'wisp.goal.rule.all', vars: { n } };
  return { key: 'wisp.goal.rule.some', vars: { k: votesNeeded(vote, n), n } };
}

/** The judges button's label: "Judges", "1 judge", "3 judges · All". */
export function judgesLabel(n: number, vote: Vote | undefined): Words {
  if (n === 0) return { key: 'wisp.goal.judges' };
  if (n === 1) return { key: 'wisp.goal.judges.one' };
  return { key: 'wisp.goal.judges.many', vars: { n, rule: t(VOTE_KEY[vote ?? 'majority']) } };
}

export const VOTE_KEY: Readonly<Record<Vote, Key>> = { all: 'wisp.goal.vote.all', majority: 'wisp.goal.vote.majority', any: 'wisp.goal.vote.any' };

export const STATE_KEY: Readonly<Record<GoalStatus, Key>> = {
  working: 'wisp.goal.state.working',
  checking: 'wisp.goal.state.checking',
  met: 'wisp.goal.state.met',
  impossible: 'wisp.goal.state.impossible',
  out: 'wisp.goal.state.out',
  paused: 'wisp.goal.state.paused',
  handed: 'wisp.goal.state.handed',
};

export const SAID_KEY: Readonly<Record<Verdict, Key>> = {
  met: 'wisp.goal.said.met',
  not_yet: 'wisp.goal.said.not_yet',
  impossible: 'wisp.goal.said.impossible',
  unchecked: 'wisp.goal.said.unchecked',
};

/** How a vote tints a face: met green, can't red, not yet amber, no answer faded. */
export const VOTE_TONE: Readonly<Record<Verdict, 'good' | 'bad' | 'warn' | 'neutral'>> = { met: 'good', impossible: 'bad', not_yet: 'warn', unchecked: 'neutral' };

/** The band's state word: a paused goal that waits for the plan reads Waiting. */
export function stateWords(g: GoalView): Words {
  if (g.status === 'paused' && g.held) return { key: 'wisp.goal.state.waiting' };
  if (stalled(g)) return { key: 'wisp.goal.state.stalled' };
  return { key: STATE_KEY[g.status] };
}

const lastProgress = (g: GoalView, back = 0): number | null => g.checks.filter((c) => c.progress != null).at(-1 - back)?.progress ?? null;

/**
 * What the track and ring draw: the checker's estimate, never full before the goal is met (a full
 * bar beside "Stalled" said two things at once), full once it is.
 */
export function shownProgress(g: GoalView, back = 0): number | null {
  if (g.status === 'met' && back === 0) return 100;
  const p = lastProgress(g, back);
  return p == null ? null : Math.max(0, Math.min(p, 99));
}

/** The change since the check before: +12, −5, or null when there's nothing to compare. */
export function progressDelta(g: GoalView): number | null {
  const p = shownProgress(g);
  const was = shownProgress(g, 1);
  return p != null && was != null && p !== was ? p - was : null;
}

/**
 * Stuck: the server pauses a goal after STALL rounds in a row that changed nothing or were told the
 * same next step (server/goal.js). The view has no `changed`, so the UI reads what it can: a pause
 * whose why says so, or the last STALL not-yet checks asking for the same next step with no gain.
 */
export function stalled(g: GoalView): boolean {
  if (g.status !== 'paused' && g.status !== 'working') return false;
  if (g.status === 'paused' && g.why && /stall/i.test(g.why)) return true;
  if (g.status !== 'paused') return false;
  const tail = g.checks.slice(-STALL);
  if (tail.length < STALL || tail.some((c) => c.verdict !== 'not_yet')) return false;
  const nexts = new Set(tail.map((c) => (c.next ?? '').trim().toLowerCase()));
  const gains = tail.map((c) => c.progress ?? null);
  return nexts.size === 1 && [...nexts][0] !== '' && gains.every((p) => p === gains[0]);
}

export const plural = (n: number): 'one' | 'other' => (n === 1 ? 'one' : 'other');

/** ms as v1's fmtDuration: 45s, 3m 05s, 2h 10m. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The band's second line: a lead in bold and the checker's words after it, by state. */
export interface CheckLine {
  readonly lead: Words;
  readonly text: string;
  readonly next?: string;
  /** the reset a waiting round goes on at */
  readonly at?: number;
}

export function checkLine(g: GoalView): CheckLine {
  const last = g.checks.at(-1);
  const why = last?.why ?? '';
  switch (g.status) {
    case 'met': {
      const spent = g.endedAt && g.setAt ? duration(g.endedAt - g.setAt) : '';
      return { lead: { key: 'wisp.goal.line.met', vars: { count: g.round } }, text: [spent, why].filter(Boolean).join(' · ') };
    }
    case 'impossible':
      return { lead: { key: 'wisp.goal.line.why' }, text: g.why ?? why };
    case 'out':
      return { lead: { key: 'wisp.goal.line.out', vars: { p: shownProgress(g) ?? 0 } }, text: why };
    case 'paused':
      if (g.held) return { lead: { key: 'wisp.goal.line.held', vars: { round: g.round } }, text: g.why ?? '', at: g.held };
      if (g.why) return { lead: { key: 'wisp.goal.line.reason', vars: { why: g.why } }, text: '' };
      return { lead: { key: 'wisp.goal.state.paused' }, text: why };
    case 'handed':
      return { lead: { key: 'wisp.goal.line.handed' }, text: '' };
    case 'checking':
      return last ? { lead: { key: 'wisp.goal.line.last' }, text: why } : { lead: { key: 'wisp.goal.line.first' }, text: '' };
    case 'working':
      if (!last) return { lead: { key: 'wisp.goal.line.after' }, text: '' };
      return { lead: { key: last.verdict === 'not_yet' ? 'wisp.goal.line.notYet' : 'wisp.goal.line.last' }, text: why, ...(last.next && { next: last.next }) };
  }
}

/** Has something to open: a check that ran, or one under way. */
export const hasChecks = (g: GoalView | undefined): boolean => !!g && (g.checks.length > 0 || (g.status === 'checking' && (g.running?.length ?? 0) > 0));

/** A goal is for a task you run: not subagents, delegates, side talks, the tour or reminders. */
export function canHaveGoal(s: SessionRow | undefined): boolean {
  return !!s && !s.parentId && s.agent !== 'wisp' && !s.pending && s.kind !== 'reminder' && !s.delegated && !s.sideOf;
}

export type GoalAction = 'set' | 'checks' | 'pause' | 'resume' | 'drop';

/** The goal's actions, the same everywhere: the band's menu, More, right-click, ⌘K. */
export function goalActions(s: SessionRow | undefined): GoalAction[] {
  if (!canHaveGoal(s)) return [];
  const g = s?.goal;
  if (!g) return ['set'];
  const out: GoalAction[] = ['set'];
  if (hasChecks(g)) out.push('checks');
  if (goalLive(g)) out.push('pause');
  else if (g.status !== 'met' && g.status !== 'handed') out.push('resume');
  out.push('drop');
  return out;
}

/** The judges' last votes, lined up with the judges, or null when they don't match the bench. */
export function lastVotes(g: GoalView): readonly Pick<JudgeVote, 'name' | 'verdict' | 'why' | 'run'>[] | null {
  const n = g.judges?.length ?? 0;
  const votes = g.last?.votes;
  return n > 0 && votes?.length === n ? votes : null;
}

/** "2/3", or "–/3" before the first vote. */
export function tally(g: GoalView): string {
  const n = g.judges?.length ?? 0;
  const votes = lastVotes(g);
  return `${votes ? votes.filter((v) => v.verdict === 'met').length : '–'}/${n}`;
}

export const isCrew = (j: Judge): j is { crew: string; name?: string } => 'crew' in j;

/** What a judge is called: a crew member's name, else the harness, model and thinking level. */
export function judgeLabel(j: Judge, crew: readonly MemberRow[], harnesses: readonly HarnessRow[]): string {
  if (isCrew(j)) return crew.find((m) => m.id === j.crew)?.name ?? j.name ?? t('wisp.goal.crewMember');
  const h = harnesses.find((x) => x.id === j.agent);
  const model = (j.model && h?.models.find((m) => m.id === j.model)?.label) || j.model;
  return [h?.name ?? j.agent, model, j.effort].filter(Boolean).join(' · ');
}

/** Names as the server keeps them (and the band shows): repeats get 2, 3… */
export function named(judges: readonly Judge[], crew: readonly MemberRow[], harnesses: readonly HarnessRow[]): Judge[] {
  const seen = new Map<string, number>();
  return judges.map((j) => {
    const base = judgeLabel(j, crew, harnesses).slice(0, 36);
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return { ...j, name: k > 1 ? `${base} ${k}` : base };
  });
}

/** Judges that still exist here: a harness wisp has, a crew member still on the crew. */
export const liveJudges = (list: readonly Judge[], crew: readonly MemberRow[], harnesses: readonly HarnessRow[]): Judge[] =>
  list.filter((j) => (isCrew(j) ? crew.some((m) => m.id === j.crew) : harnesses.some((h) => h.id === j.agent)));

/** The next harness nobody judges with yet, else the first one installed. */
export function nextHarness(list: readonly Judge[], harnesses: readonly HarnessRow[]): HarnessRow | undefined {
  const ready = harnesses.filter((h) => h.available);
  const used = new Set(list.flatMap((j) => (isCrew(j) ? [] : [j.agent])));
  return ready.find((h) => !used.has(h.id)) ?? ready[0];
}

/** The goal the page shows at once after a set (the server's answer replaces it). */
export function optimisticGoal(prev: GoalView | undefined, text: string, o: { sending: boolean; running: boolean; judges?: readonly Judge[]; vote?: Vote; now: number }): GoalView {
  const base: GoalView = prev && goalLive(prev) ? prev : { text, round: 1, checks: [], setAt: o.now, status: 'working', ...(prev?.judges && { judges: prev.judges }), ...(prev?.vote && { vote: prev.vote }) };
  const status: GoalStatus = o.sending || (o.running && prev?.status !== 'checking') ? 'working' : 'checking';
  const next: GoalView = { ...base, text, status };
  if (o.judges) {
    delete next.judges;
    delete next.vote;
    if (o.judges.length) Object.assign(next, { judges: [...o.judges], vote: o.vote ?? 'majority' });
    // other judges: the last votes were someone else's (the server sets them aside too)
    const same = JSON.stringify([prev?.judges ?? [], prev?.vote]) === JSON.stringify([next.judges ?? [], next.vote]);
    if (!same && next.last) next.last = { verdict: next.last.verdict, why: next.last.why, ...(next.last.tally && { tally: next.last.tally }) };
  }
  return next;
}

/** A row in "Earlier rounds": each round's verdict and why, newest first. */
export function earlierRounds(g: GoalView): CheckView[] {
  const n = g.judges?.length ?? 0;
  const ownRows = n > 0 && g.status !== 'checking' && lastVotes(g) !== null;
  return [...g.checks].reverse().slice(ownRows ? 1 : 0);
}
