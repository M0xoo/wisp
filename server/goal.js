// Goals: a task that keeps going until a condition holds. After each round (a turn) wisp checks
// the work against the goal with a read-only run of a cheap model in the task's folder; while it
// isn't met, the task goes back to its agent with what's missing. It lands in your queue once the
// goal is met, can't be met, or ran out of rounds (design/goals.md).
//
// State lives on the session as `goal`: { text, max, round, status, setAt, endedAt?, why?, checks[] }
// status: working (the agent is on a round) · checking · met · impossible · out (of rounds) · paused
//         · handed (Auto moved the task to another run, which carries the goal on)

import { askJson, cheapest } from './quick.js';
import { check as runCheck } from './check.js';
import { diffOf } from './judge.js';
import { heroOf } from './protocol.js';
import { bad, clip } from './util.js';
import { workdir } from './runner.js';

export const GOAL_ROUNDS = [3, 5, 10, 20];
export const DEFAULT_ROUNDS = 10;
const MAX_TEXT = 1000;
const CHECK_MS = 180_000;
// This many rounds in a row that changed nothing, or were told the same next step: it's stuck.
const STALL = 2;
const MAX_DIFF = 20_000;

export const ENDED = new Set(['met', 'impossible', 'out', 'handed']);
const VERDICTS = new Set(['met', 'not_yet', 'impossible']);

const GOAL_CMD = /^\/goal(?:\s+|$)/i;
// The condition in "/goal all tests pass" ('' for a bare /goal), or null when the text isn't one.
export function goalCommand(text) {
  const t = String(text || '').trim();
  return GOAL_CMD.test(t) ? t.replace(GOAL_CMD, '').trim() : null;
}

// { text, max } from a request body, or null for none. Throws on a bad one.
export function normalizeGoal(g, fallbackMax = DEFAULT_ROUNDS) {
  if (g == null || g === false) return null;
  const text = String(typeof g === 'string' ? g : g.text ?? '').trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) throw bad(`A goal is at most ${MAX_TEXT} characters.`);
  const max = Number(typeof g === 'object' ? g.max ?? fallbackMax : fallbackMax);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw bad('goal.max must be a whole number of rounds from 1 to 20.');
  return { text, max };
}

// What the agent hears about its goal, every turn.
export function goalNote(s) {
  const g = s.goal;
  if (!g || ENDED.has(g.status)) return '';
  return `\n\n## Goal\n\nThis task has a goal. It is done only when this is true:\n\n> ${g.text.replace(/\n/g, '\n> ')}\n\nAfter each of your turns wisp checks your work against it, independently, by reading the files (it doesn't take your word for it). While it isn't met, the task comes back to you with what's missing (round ${g.round} of ${g.max} now). Work until it is met, and verify it yourself before you finish. If it can't be met (it needs access you don't have, contradicts itself, or only the user can do part of it), stop trying and say exactly why in your report, with the hero's status "blocked".`;
}

// The goal on a summary: what the row, the band and the details need.
export function goalView(g) {
  if (!g) return undefined;
  const last = g.checks.at(-1);
  return { text: g.text, status: g.status, round: g.round, max: g.max, ...(g.budget && { budget: g.budget }), ...(g.why && { why: g.why }), setAt: g.setAt, ...(g.endedAt && { endedAt: g.endedAt }), checks: g.checks.slice(-50).map(({ round, verdict, why, next, progress, at, tests }) => ({ round, verdict, why, ...(next && { next }), ...(progress != null && { progress }), ...(tests && { tests }), at })), ...(last && { last: { verdict: last.verdict, why: last.why } }) };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Goals {
  // deps: { store, runner, agents(), defaults(), projectOf(session), track?(event, props) }
  constructor(deps) {
    Object.assign(this, deps);
    this.tokens = new Map(); // sessionId -> the check in flight; a move by the user cancels it
  }

  // A fresh goal on a session (at launch, or set later). Doesn't start anything.
  attach(session, goal, { by = 'user' } = {}) {
    const g = normalizeGoal(goal, this.rounds());
    if (!g) return null;
    session.goal = { ...g, budget: g.max, round: 1, status: 'working', setAt: Date.now(), by, checks: [] }; // from: the first turn, set as it starts
    return session.goal;
  }

  rounds() {
    const n = Number(this.defaults?.().goalRounds);
    return GOAL_ROUNDS.includes(n) ? n : DEFAULT_ROUNDS;
  }

  // Set or replace the goal from the task (PUT, or /goal in a follow-up). An idle task is checked
  // at once (it may already be met) and goes on from there; a running one is checked after its turn.
  set(session, goal) {
    if (session.parentId || session.delegated || session.agent === 'wisp') throw bad('Only a task of your own can have a goal.', 409);
    const prev = session.goal;
    const g = normalizeGoal(goal, prev?.max || this.rounds());
    if (!g) throw bad('Say what has to be true, like “all tests pass”.');
    this.tokens.delete(session.id);
    // Editing the words of a goal still being worked on keeps its rounds; anything else starts over.
    const keep = prev && !ENDED.has(prev.status) && prev.status !== 'paused';
    session.goal = keep ? { ...prev, ...g, status: prev.status === 'checking' ? 'working' : prev.status, why: undefined } : { ...g, budget: g.max, round: 1, status: 'working', setAt: Date.now(), by: 'user', checks: [], from: session.turns.at(-1)?.id };
    this.#note(session, `Goal set: ${g.text}`);
    this.#kick(session);
    return session.goal;
  }

  // Back to work on a paused goal, or one out of rounds, with a fresh budget of rounds.
  resume(session) {
    const g = session.goal;
    if (!g) throw bad('This task has no goal.', 404);
    if (g.status === 'met') throw bad('The goal is already met.', 409);
    if (g.status === 'working' || g.status === 'checking') return g;
    Object.assign(g, { status: 'working', why: undefined, endedAt: undefined });
    if (g.round >= g.max) g.max = g.round + (g.budget || g.max); // its next check gets the rounds it started with
    this.#note(session, 'Goal resumed');
    this.#kick(session);
    return g;
  }

  // Pause it: the agent finishes its round, and the task then lands in your queue.
  pause(session, why = 'You paused it') {
    const g = session.goal;
    if (!g) throw bad('This task has no goal.', 404);
    if (ENDED.has(g.status) || g.status === 'paused') return g;
    const checking = g.status === 'checking';
    this.tokens.delete(session.id);
    Object.assign(g, { status: 'paused', why });
    if (checking) this.runner.settle(session);
    else this.runner.refresh(session);
    return g;
  }

  drop(session) {
    if (!session.goal) return false;
    const checking = session.goal.status === 'checking';
    this.tokens.delete(session.id);
    delete session.goal;
    if (checking) this.runner.settle(session);
    else this.runner.refresh(session);
    return true;
  }

  // An idle task with a live goal gets checked now; one that's running is checked when its turn ends.
  // A run still live after its turn landed is a CLI on its way out (or handing to a follow-up):
  // only the hand-over counts as busy, or the goal would wait for a turn end that already came.
  #kick(session) {
    const last = session.turns.at(-1);
    const handing = this.runner.live.has(session.id) && (session.state === 'running' || session.queue?.length > 0);
    const idle = !handing && last?.status !== 'running' && !session.auto?.busy && session.state !== 'waiting';
    if (!idle || !last) return this.runner.refresh(session);
    session.state = 'running';
    session.unread = false;
    delete session.archived;
    this.run(session, last);
  }

  // Called as a turn ends (and as Auto settles): true keeps the session in Working for a check.
  wants(session, turn, ev = {}) {
    const g = session.goal;
    if (!g || g.status !== 'working' || session.parentId || session.delegated) return false;
    if (ev.stopped) return this.#pauseQuiet(session, 'You stopped the run'), false;
    if (ev.isError) return this.#pauseQuiet(session, 'The run ended with an error'), false;
    return true;
  }

  // The user's Stop: the goal waits for them. A follow-up of theirs leaves it on (it's checked
  // after their turn), but a check in flight is dropped: that turn is no longer the latest.
  // Returns whether a check was in flight (a Stop then has to land the task itself).
  cancel(session, { stop = false } = {}) {
    const g = session.goal;
    if (!g) return false;
    const checking = g.status === 'checking';
    if (checking) this.tokens.delete(session.id);
    if (stop && !ENDED.has(g.status)) Object.assign(g, { status: 'paused', why: 'You stopped it' });
    else if (checking) g.status = 'working';
    return checking;
  }

  // Auto moved the task to another run (a stronger pick, or one not at its limit): that run gets
  // the goal, with the rounds left; this one is done with it.
  handOff(session) {
    const g = session.goal;
    if (!g || ENDED.has(g.status)) return null;
    this.tokens.delete(session.id);
    Object.assign(g, { status: 'handed', endedAt: Date.now() });
    return { text: g.text, max: Math.max(1, g.max - g.round + 1) };
  }

  #pauseQuiet(session, why) {
    Object.assign(session.goal, { status: 'paused', why });
  }

  async run(session, turn) {
    const g = session.goal;
    const token = Symbol('goal');
    this.tokens.set(session.id, token);
    const live = () => this.tokens.get(session.id) === token && this.store.get(session.id) === session && session.goal === g;
    g.status = 'checking';
    this.runner.note(session, turn, { kind: 'goal', label: 'Checking the goal…' });
    let v;
    try {
      v = await this.check(session, turn);
    } catch (err) {
      console.warn(`wisp: goal check: ${err.stack || err.message}`);
      v = null;
    }
    if (!live()) return;
    const changed = (turn.changes || []).length;
    const entry = { turnId: turn.id, round: g.round, at: Date.now(), verdict: v?.verdict || 'unchecked', why: v?.why || 'No model could check the goal.', ...(v?.next && { next: v.next }), ...(v?.progress != null && { progress: v.progress }), ...(v?.tests && { tests: v.tests }), changed };
    g.checks.push(entry);
    if (g.checks.length > 50) g.checks.splice(0, g.checks.length - 50);
    const done = (status, label, why) => {
      Object.assign(g, { status, endedAt: Date.now(), ...(why && { why }) });
      this.runner.note(session, turn, { kind: 'goal', label });
      this.track?.('goal_ended', { status, rounds: g.round, max: g.max });
      this.tokens.delete(session.id);
      this.runner.settle(session);
    };
    if (entry.verdict === 'met') return done('met', 'Goal check: met');
    if (entry.verdict === 'impossible') return done('impossible', 'Goal check: can’t be done', entry.why);
    if (entry.verdict === 'unchecked') {
      Object.assign(g, { status: 'paused', why: entry.why });
      this.runner.note(session, turn, { kind: 'goal', label: 'Goal check: couldn’t check' });
      this.tokens.delete(session.id);
      return this.runner.settle(session);
    }
    if (this.#stalled(g)) {
      Object.assign(g, { status: 'paused', why: `Stalled: ${plural(STALL, 'round')} in a row got nowhere` });
      this.runner.note(session, turn, { kind: 'goal', label: 'Goal check: going in circles' });
      this.tokens.delete(session.id);
      return this.runner.settle(session);
    }
    if (g.round >= g.max) return done('out', 'Goal check: out of rounds', `Still not met after ${plural(g.max, 'round')}`);
    g.round++;
    g.status = 'working';
    this.tokens.delete(session.id);
    this.runner.note(session, turn, { kind: 'goal', label: 'Goal check: not yet' });
    this.runner.reply(session, continuePrompt(g, entry), [], { by: 'wisp', goal: g.round });
  }

  // Rounds that changed nothing, or were sent back with the same next step and no more progress:
  // going in circles.
  #stalled(g) {
    const tail = g.checks.slice(-STALL);
    if (tail.length < STALL || !tail.every((c) => c.verdict === 'not_yet')) return false;
    const flat = tail.every((c, i) => !i || (c.progress ?? 0) <= (tail[i - 1].progress ?? 0));
    return tail.every((c) => !c.changed) || (!!tail[0].next && flat && tail.every((c) => c.next === tail[0].next));
  }

  // { verdict, why, next, progress, tests } or null when nothing could check it. The project's
  // tests run first (Auto's run of this turn counts): a "met" they contradict is "not yet".
  async check(session, turn) {
    const g = session.goal;
    const dir = workdir(session);
    const auto = session.auto?.checks?.findLast((c) => c.turnId === turn.id);
    const tests = auto || (await runCheck({ dir, project: this.projectOf?.(session), worktree: session.worktree }).catch(() => null));
    if (this.tokens.get(session.id) === undefined) return null; // cancelled while the tests ran
    const base = (g.from && session.turns.find((t) => t.id === g.from)?.checkpoint?.commit) || session.worktree?.head || 'HEAD';
    const diff = diffOf(dir, base);
    const agents = this.agents();
    const pick = cheapest(agents) || (agents.some((a) => a.id === session.agent && a.available) ? { agent: session.agent, model: session.model || '' } : null);
    const j = await askJson({ agents, prompt: checkPrompt(session, turn, g, { tests, diff }), cwd: dir, timeoutMs: CHECK_MS, pick });
    if (!j || !VERDICTS.has(j.verdict)) return null;
    const progress = Number(j.progress);
    const failing = tests?.verdict === 'fail';
    const evidence = Array.isArray(j.evidence) ? j.evidence.filter((e) => typeof e === 'string' && e.trim()) : [];
    // A "met" needs what the checker saw for itself, and tests that don't disagree.
    const verdict = j.verdict === 'met' && (failing || !evidence.length) ? 'not_yet' : j.verdict;
    const overruled = verdict !== j.verdict;
    return {
      verdict,
      why: clip(overruled ? (failing ? `The tests fail: ${tests.newFailures?.length || tests.failed || 'some'} new failure${(tests.newFailures?.length || tests.failed) === 1 ? '' : 's'} in ${tests.command || 'the tests'}` : `The check couldn't point at anything that shows it: ${String(j.why || '').trim()}`) : String(j.why || '').trim() || (verdict === 'met' ? 'The goal holds.' : 'Not there yet.'), 300),
      next: verdict === 'not_yet' ? clip(String(j.next || '').trim() || (failing ? `Make ${tests.command || 'the tests'} pass again.` : ''), 400) : '',
      progress: Number.isFinite(progress) ? Math.max(0, Math.min(overruled ? 95 : 100, Math.round(progress))) : verdict === 'met' ? 100 : null,
      ...(tests && tests.verdict !== 'skip' && { tests: { verdict: tests.verdict, command: tests.command } }),
    };
  }

  #note(session, label) {
    const turn = session.turns.at(-1);
    if (turn) this.runner.note(session, turn, { kind: 'goal', label });
  }
}

function checkPrompt(s, turn, g, { tests, diff }) {
  const hero = heroOf(turn.presentation);
  const history = g.checks.slice(-4).map((c) => `- round ${c.round}: ${c.verdict}: ${c.why}`).join('\n');
  return `You check whether a coding agent reached its goal. Your working directory is the project it works in: open the files, read the code, look at git status and diffs. Don't take the agent's word for anything you can check yourself.

<goal>
${g.text}
</goal>

<task>
${clip(s.turns[0]?.prompt || '', 3000)}
</task>

<changes since the goal was set>
${diff ? clip(diff, MAX_DIFF) : '(none)'}
</changes>

Files changed this round: ${(turn.changes || []).map((c) => c.file).slice(0, 40).join(', ') || 'none'}
${tests && tests.verdict !== 'skip' ? `wisp ran the project's tests itself: ${tests.verdict}${tests.command ? ` (${tests.command})` : ''}${tests.newFailures?.length ? `, new failures: ${tests.newFailures.slice(0, 10).join(', ')}` : ''}\n` : ''}${history ? `Earlier checks:\n${history}\n` : ''}
<agent-claim round="${g.round}" of="${g.max}">
What the agent says it did. A claim, not evidence: check it.
${hero ? `${hero.title || ''}: ${hero.summary || ''} (status ${hero.status || 'unknown'})\n` : ''}${clip(turn.raw || '', 6000)}
</agent-claim>

Verdicts:
- "met": every part of the goal holds now, and you verified it.
- "not_yet": something is missing or broken, and the agent can still do it.
- "impossible": it can't be done here: it needs access or decisions only the user has, contradicts itself, or the agent showed it can't be done. Not merely hard.

Reply with one JSON object: {"verdict": "met" | "not_yet" | "impossible", "why": "one specific sentence", "evidence": ["what you saw yourself that shows it: a file and line, a diff hunk, a test result"], "next": "the concrete next step, when not_yet", "progress": 0-100}`;
}

function continuePrompt(g, c) {
  return [
    `wisp checked your work against the goal and it isn't met yet (round ${g.round} of ${g.max} starts now).`,
    `Goal: ${g.text}`,
    `What's missing: ${c.why}`,
    c.next ? `Next: ${c.next}` : '',
    'Keep working until the goal is met, and check it yourself before you finish. If it turns out it can’t be done, stop and say exactly why, with the hero’s status "blocked".',
  ]
    .filter(Boolean)
    .join('\n\n');
}
