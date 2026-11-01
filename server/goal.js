// Goals: a task that keeps going until a condition holds. After each round (a turn) wisp checks
// the work against the goal with a read-only run of a cheap model in the task's folder; while it
// isn't met, the task goes back to its agent with what's missing. There's no cap on rounds: it lands in
// your queue once the goal is met, can't be met, or goes in circles (design/goals.md).
//
// Judges: with `judges` set, each of them checks the work on its own (any harness, model and
// thinking level, or a crew member on theirs) and the goal is met only when their votes agree by
// `vote`: all of them, a majority, or any one.
//
// State lives on the session as `goal`: { text, round, status, setAt, endedAt?, why?, checks[], fresh?, judges?, vote?, bench? }
// bench: bumped each time the judges change; a check's votes count only for the bench that cast them
// fresh: where the checks start that count toward a stall (set on Resume)
// status: working (the agent is on a round) · checking · met · impossible · paused
//         · out (goals from before rounds were unlimited: ran out of them; Resume carries on)
//         · handed (Auto moved the task to another run, which carries the goal on)
// held: the reset a paused goal's next round waits for (Automations stop at, server/budget.js). The
//       round itself is a scheduled follow-up by wisp with `goal` (server/later.js), under Scheduled.

import { askJson, cheapest } from './quick.js';
import { check as runCheck } from './check.js';
import { diffOf } from './judge.js';
import { heroOf } from './protocol.js';
import { bad, clip } from './util.js';
import { adapters } from './adapters/index.js';
import { workdir } from './runner.js';

const MAX_TEXT = 1000;
const CHECK_MS = 180_000;
// This many rounds in a row that changed nothing, or were told the same next step: it's stuck.
const STALL = 2;
const MAX_DIFF = 20_000;

export const ENDED = new Set(['met', 'impossible', 'out', 'handed']);
const VERDICTS = new Set(['met', 'not_yet', 'impossible']);
const MAX_JUDGES = 5;
// How the judges' votes add up to "met". Can't be done always takes a majority of them.
export const VOTES = { all: 'All', majority: 'Majority', any: 'Any' };
const majorityOf = (n) => Math.floor(n / 2) + 1;
export const votesNeeded = (vote, n) => (vote === 'all' ? n : vote === 'any' ? 1 : majorityOf(n));

const GOAL_CMD = /^\/goal(?:\s+|$)/i;
// The condition in "/goal all tests pass" ('' for a bare /goal), or null when the text isn't one.
export function goalCommand(text) {
  const t = String(text || '').trim();
  return GOAL_CMD.test(t) ? t.replace(GOAL_CMD, '').trim() : null;
}

// { text, judges?, vote? } from a request body, or null for none. Throws on a bad one. judges is
// left out when the body doesn't say (an edit keeps the ones it had); [] clears them. An old
// client's `max` is ignored.
export function normalizeGoal(g) {
  if (g == null || g === false) return null;
  const text = String(typeof g === 'string' ? g : g.text ?? '').trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) throw bad(`A goal is at most ${MAX_TEXT} characters.`);
  const out = { text };
  if (typeof g === 'object' && g.judges != null) out.judges = normalizeJudges(g.judges);
  if (typeof g === 'object' && g.vote != null) {
    if (!Object.hasOwn(VOTES, g.vote)) throw bad(`vote must be one of ${Object.keys(VOTES).join(', ')}.`);
    out.vote = g.vote;
  }
  return out;
}

// Each judge: a harness with its model and thinking level, or a crew member (who brings theirs).
export function normalizeJudges(list) {
  if (!Array.isArray(list)) throw bad('judges must be a list.');
  if (list.length > MAX_JUDGES) throw bad(`A goal has at most ${MAX_JUDGES} judges.`);
  return list.map((j) => {
    if (!j || typeof j !== 'object') throw bad('Each judge is { agent, model, effort } or { crew }.');
    const name = clip(String(j.name || '').replace(/\s+/g, ' ').trim(), 40);
    if (j.crew) return { crew: String(j.crew).slice(0, 64), ...(name && { name }) };
    const agent = String(j.agent || '');
    if (!adapters[agent]) throw bad(`A judge needs a harness wisp knows (${Object.keys(adapters).join(', ')}), not “${agent || 'none'}”.`);
    return { agent, model: String(j.model || '').slice(0, 120), effort: String(j.effort || '').slice(0, 20), ...(name && { name }) };
  });
}

// Keep the judges on the goal only when there are some; the vote only with them.
// Different judges (or another rule) start the stall count over and set the old votes aside.
export function withJudges(goal, judges, vote) {
  const was = JSON.stringify([goal.judges || [], goal.judges ? goal.vote : null]);
  delete goal.judges;
  delete goal.vote;
  if (judges?.length) Object.assign(goal, { judges, vote: vote || 'majority' });
  if (JSON.stringify([goal.judges || [], goal.judges ? goal.vote : null]) !== was && goal.checks?.length) Object.assign(goal, { bench: (goal.bench || 0) + 1, fresh: goal.checks.length });
  return goal;
}

// What the agent hears about its goal, every turn.
export function goalNote(s) {
  const g = s.goal;
  if (!g || ENDED.has(g.status)) return '';
  return `\n\n## Goal\n\nThis task has a goal. It is done only when this is true:\n\n> ${g.text.replace(/\n/g, '\n> ')}\n\nAfter each of your turns wisp checks your work against it, independently, by reading the files (it doesn't take your word for it). While it isn't met, the task comes back to you with what's missing (round ${g.round} now). Work until it is met, and verify it yourself before you finish. If it can't be met (it needs access you don't have, contradicts itself, or only the user can do part of it), stop trying and say exactly why in your report, with the hero's status "blocked".`;
}

// The goal on a summary: what the row, the band and the details need.
export function goalView(g) {
  if (!g) return undefined;
  const last = g.checks.at(-1);
  return { text: g.text, ...(g.judges && { judges: g.judges, vote: g.vote }), status: g.status, round: g.round, ...(g.why && { why: g.why }), ...(g.held && { held: g.held }), setAt: g.setAt, ...(g.endedAt && { endedAt: g.endedAt }), checks: g.checks.slice(-50).map(({ round, verdict, why, next, progress, at, tests, tally }) => ({ round, verdict, why, ...(next && { next }), ...(progress != null && { progress }), ...(tests && { tests }), ...(tally && { tally }), at })), ...(last && { last: { verdict: last.verdict, why: last.why, ...(last.tally && { tally: last.tally }), ...(last.votes && (last.bench || 0) === (g.bench || 0) && { votes: last.votes.map(({ name, verdict, why }) => ({ name, verdict, why })) }) } }) };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Goals {
  // deps: { store, runner, agents(), defaults(), projectOf(session), track?(event, props),
  //         hold?(session) → what holds back automations on its account, schedule?(session, entry) → Later.add,
  //         crew?(id) → a crew member, for one who judges }
  constructor(deps) {
    Object.assign(this, deps);
    this.tokens = new Map(); // sessionId -> the check in flight; a move by the user cancels it
  }

  // A fresh goal on a session (at launch, or set later). Doesn't start anything.
  attach(session, goal, { by = 'user' } = {}) {
    const g = normalizeGoal(goal);
    if (!g) return null;
    session.goal = withJudges({ text: g.text, round: 1, status: 'working', setAt: Date.now(), by, checks: [] }, g.judges, g.vote); // from: the first turn, set as it starts
    return session.goal;
  }

  // Set or replace the goal from the task (PUT, or /goal in a follow-up). An idle task is checked
  // at once (it may already be met) and goes on from there; a running one is checked after its turn.
  // kick: false: a follow-up that goes with it starts next, so nothing is checked now, and `from` is
  // left for that turn to fill (Runner#startTurn), which also hands the agent the goal.
  set(session, goal, { kick = true } = {}) {
    if (session.parentId || session.delegated || session.agent === 'wisp') throw bad('Only a task of your own can have a goal.', 409);
    const prev = session.goal;
    const g = normalizeGoal(goal);
    if (!g) throw bad('Say what has to be true, like “all tests pass”.');
    this.tokens.delete(session.id);
    this.#unhold(session);
    // Editing the words of a goal still being worked on keeps its rounds; anything else starts over.
    const keep = prev && !ENDED.has(prev.status) && prev.status !== 'paused';
    const next = keep ? { ...prev, text: g.text, status: prev.status === 'checking' ? 'working' : prev.status, why: undefined } : { text: g.text, round: 1, status: 'working', setAt: Date.now(), by: 'user', checks: [], ...(kick && { from: session.turns.at(-1)?.id }) };
    // Judges the request didn't name stay as they were (a typed /goal only changes the words).
    session.goal = withJudges(next, g.judges !== undefined ? g.judges : prev?.judges, g.vote || prev?.vote);
    this.#note(session, `Goal set: ${g.text}`);
    if (kick) this.#kick(session);
    return session.goal;
  }

  // Back to work on a paused goal (or an old one that ran out of rounds).
  resume(session) {
    const g = session.goal;
    if (!g) throw bad('This task has no goal.', 404);
    if (g.status === 'met') throw bad('The goal is already met.', 409);
    if (g.status === 'working' || g.status === 'checking') return g;
    // A round that waited for the plan: you said go, so it goes now, without checking again.
    const waiting = g.held && this.#unhold(session);
    if (waiting) {
      Object.assign(g, { status: 'working', why: undefined });
      this.#note(session, 'Goal resumed');
      this.runner.reply(session, waiting.text, [], { by: 'wisp', goal: waiting.goal });
      return g;
    }
    // Stalled rounds before the resume don't count: you said go on, so it gets a fresh look.
    Object.assign(g, { status: 'working', why: undefined, endedAt: undefined, fresh: g.checks.length });
    this.#note(session, 'Goal resumed');
    this.#kick(session);
    return g;
  }

  // Pause it: the agent finishes its round, and the task then lands in your queue.
  pause(session, why = 'You paused it') {
    const g = session.goal;
    if (!g) throw bad('This task has no goal.', 404);
    if (g.held) {
      // It was waiting for the plan: now it waits for you, back out of Scheduled.
      this.#unhold(session);
      Object.assign(g, { why });
      if (session.state === 'done') session.state = 'review';
      this.runner.refresh(session);
      return g;
    }
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
    if (this.#unhold(session) && session.state === 'done') session.state = 'review'; // out of Scheduled, back to you
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
    const handing = this.runner.live.has(session.id) && (session.state === 'running' || (session.queue?.length > 0 && !session.queueHeld));
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
    // A goal already paused keeps its reason (one waiting for the plan keeps waiting): Stop, and
    // every task wisp stops as it quits, only pause a goal that was going.
    if (stop && !ENDED.has(g.status) && g.status !== 'paused') Object.assign(g, { status: 'paused', why: 'You stopped it' });
    else if (checking) g.status = 'working';
    return checking;
  }

  // Auto moved the task to another run (a stronger pick, or one not at its limit): that run gets
  // the goal; this one is done with it.
  handOff(session) {
    const g = session.goal;
    if (!g || ENDED.has(g.status)) return null;
    this.tokens.delete(session.id);
    Object.assign(g, { status: 'handed', endedAt: Date.now() });
    return { text: g.text, ...(g.judges && { judges: g.judges, vote: g.vote }) };
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
    const entry = { turnId: turn.id, round: g.round, at: Date.now(), verdict: v?.verdict || 'unchecked', why: v?.why || 'No model could check the goal.', ...(v?.next && { next: v.next }), ...(v?.progress != null && { progress: v.progress }), ...(v?.tests && { tests: v.tests }), ...(v?.tally && { tally: v.tally }), ...(v?.votes && { votes: v.votes, bench: g.bench || 0 }), changed };
    g.checks.push(entry);
    if (g.checks.length > 50) {
      const cut = g.checks.length - 50;
      g.checks.splice(0, cut);
      if (g.fresh) g.fresh = Math.max(0, g.fresh - cut);
    }
    const done = (status, label, why) => {
      Object.assign(g, { status, endedAt: Date.now(), ...(why && { why }) });
      this.runner.note(session, turn, { kind: 'goal', label });
      this.track?.('goal_ended', { status, rounds: g.round });
      this.tokens.delete(session.id);
      this.runner.settle(session);
    };
    if (entry.verdict === 'met') return done('met', 'Goal check: met');
    if (entry.verdict === 'impossible') return done('impossible', 'Goal check: can’t be done', entry.why);
    if (entry.verdict === 'unchecked') {
      if (!v && g.judges) entry.why = 'None of the judges could check the goal.';
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
    g.round++;
    g.status = 'working';
    this.tokens.delete(session.id);
    this.runner.note(session, turn, { kind: 'goal', label: 'Goal check: not yet' });
    const prompt = continuePrompt(g, entry);
    // Automations stop at: the account is past it, so the next round waits for the reset.
    const h = this.hold?.(session);
    if (h) return this.#waitForPlan(session, turn, prompt, h);
    this.runner.reply(session, prompt, [], { by: 'wisp', goal: g.round });
  }

  // The next round goes at the reset, as a follow-up by wisp under Scheduled; nobody is pinged.
  // If it can't be scheduled (the task has its five), the goal pauses and the task lands with you.
  #waitForPlan(session, turn, prompt, h) {
    const g = session.goal;
    let scheduled = false;
    try {
      scheduled = !!this.schedule?.(session, { text: prompt, by: 'wisp', goal: g.round, held: { why: h.why, until: h.until }, at: Math.max(h.until, Date.now() + 61_000) });
    } catch {}
    Object.assign(g, { status: 'paused', why: `Waits for your plan: ${h.why}`, ...(scheduled && { held: h.until }) });
    this.runner.note(session, turn, { kind: 'goal', label: 'Next round waits for your plan' });
    if (!scheduled) return this.runner.settle(session);
    Object.assign(session, { state: 'done', unread: false });
    this.runner.refresh(session);
  }

  // The plan's reset came (server/later.js fires the waiting round), or you sent it now: the round goes.
  // null: it lapsed (the goal was dropped, replaced or resumed meanwhile).
  carryOn(session, l) {
    const g = session.goal;
    if (!g?.held || g.status !== 'paused') return null;
    Object.assign(g, { status: 'working', why: undefined, held: undefined });
    return this.runner.reply(session, l.text, [], { by: 'wisp', goal: l.goal });
  }

  // The round that waited for the plan, taken off Scheduled. Returns it, or null.
  #unhold(session) {
    const g = session.goal;
    if (g) delete g.held;
    const l = session.later?.find((x) => x.goal);
    if (!l) return null;
    session.later = session.later.filter((x) => !x.goal);
    if (!session.later.length) delete session.later;
    return l;
  }

  // Rounds that changed nothing, or were sent back with the same next step and no more progress:
  // going in circles.
  #stalled(g) {
    const tail = g.checks.slice(g.fresh || 0).slice(-STALL);
    if (tail.length < STALL || !tail.every((c) => c.verdict === 'not_yet')) return false;
    const flat = tail.every((c, i) => !i || (c.progress ?? 0) <= (tail[i - 1].progress ?? 0));
    return tail.every((c) => !c.changed) || (!!tail[0].next && flat && tail.every((c) => c.next === tail[0].next));
  }

  // { verdict, why, next, progress, tests } or null when nothing could check it. The project's
  // tests run first: a "met" they contradict is "not yet".
  async check(session, turn) {
    const g = session.goal;
    const dir = workdir(session);
    const tests = await runCheck({ dir, project: this.projectOf?.(session), worktree: session.worktree }).catch(() => null);
    if (this.tokens.get(session.id) === undefined) return null; // cancelled while the tests ran
    const base = (g.from && session.turns.find((t) => t.id === g.from)?.checkpoint?.commit) || session.worktree?.head || 'HEAD';
    const diff = diffOf(dir, base);
    const agents = this.agents();
    if (g.judges) return this.#judge(session, turn, g, { agents, dir, tests, diff });
    const pick = cheapest(agents) || (agents.some((a) => a.id === session.agent && a.available) ? { agent: session.agent, model: session.model || '' } : null);
    const j = await askJson({ agents, prompt: checkPrompt(session, turn, g, { tests, diff }), cwd: dir, timeoutMs: CHECK_MS, pick });
    return readVerdict(j, tests);
  }

  // Every judge checks on its own, at once; their votes decide. A judge that can't answer (not
  // installed, timed out, left the crew) votes for nothing, so with All it holds the goal back:
  // when only those hold it back the agent has nothing to fix, so the goal pauses for you.
  async #judge(session, turn, g, { agents, dir, tests, diff }) {
    const n = g.judges.length;
    const votes = await Promise.all(
      g.judges.map(async (judge) => {
        const c = judge.crew ? this.crew?.(judge.crew) : null;
        const name = judge.name || c?.name || judge.agent || 'A crew member';
        if (judge.crew && !c) return { name, crew: judge.crew, verdict: 'unchecked', why: `${name} left your crew.` };
        let run = c ? { agent: c.agent, model: c.model || '', effort: c.effort || '' } : judge;
        // A crew member on Auto: the pick Auto would make for this check.
        if (run.agent === 'auto') {
          const pick = this.runner.routeAuto?.(`Check whether this goal holds: ${g.text}`, { cwd: dir });
          run = pick ? { agent: pick.agent, model: pick.model || '', effort: pick.effort || '' } : cheapest(agents) || run;
        }
        const vote = { name, agent: run.agent, ...(run.model && { model: run.model }), ...(judge.crew && { crew: judge.crew }) };
        if (!agents.find((a) => a.id === run.agent)?.available) return { ...vote, verdict: 'unchecked', why: `${name} isn't installed here.` };
        const j = await askJson({ agents, prompt: checkPrompt(session, turn, g, { tests, diff, judge: { name, role: c?.role, n } }), cwd: dir, timeoutMs: CHECK_MS, pick: run }).catch(() => null);
        const v = readVerdict(j, tests);
        if (!v) return { ...vote, verdict: 'unchecked', why: `${name} didn't answer.` };
        return { ...vote, verdict: v.verdict, why: v.why, ...(v.next && { next: v.next }), ...(v.progress != null && { progress: v.progress }) };
      }),
    );
    const answered = votes.filter((v) => v.verdict !== 'unchecked');
    if (!answered.length) return null;
    const count = (verdict) => votes.filter((v) => v.verdict === verdict).length;
    const need = votesNeeded(g.vote, n);
    const met = count('met');
    const rule = n === 1 ? 'the judge decides' : g.vote === 'all' ? 'all must agree' : g.vote === 'any' ? 'one is enough' : `${need} of ${n} must agree`;
    const tally = `${met} of ${n} judge${n === 1 ? '' : 's'} say met (${rule})`;
    const named = (v) => (n > 1 ? `${v.name}: ${v.why}` : v.why);
    const shared = { tally, votes, ...(tests && tests.verdict !== 'skip' && { tests: { verdict: tests.verdict, command: tests.command } }) };
    if (met >= need) return { ...shared, verdict: 'met', why: clip(named(votes.find((v) => v.verdict === 'met')), 300), next: '', progress: 100 };
    if (count('impossible') >= majorityOf(n)) return { ...shared, verdict: 'impossible', why: clip(named(votes.find((v) => v.verdict === 'impossible')), 300), next: '', progress: null };
    const against = votes.filter((v) => v.verdict === 'not_yet' || v.verdict === 'impossible');
    // Held back only by judges that didn't answer: nothing for the agent to do.
    if (!against.length) {
      const silent = votes.filter((v) => v.verdict === 'unchecked');
      return { ...shared, verdict: 'unchecked', why: clip(`${tally}: ${silent.map((v) => v.why).join(' ')}`, 300) };
    }
    const est = against.map((v) => v.progress).filter((x) => x != null);
    return {
      ...shared,
      verdict: 'not_yet',
      why: clip(against.map(named).join(' · '), 300),
      next: clip([...new Set(against.filter((v) => v.next).map((v) => (n > 1 ? `${v.name}: ${v.next}` : v.next)))].join(' · '), 400),
      // The dissenters' estimate: the judges that are satisfied don't pull the bar up.
      progress: est.length ? Math.min(...est) : null,
    };
  }

  #note(session, label) {
    const turn = session.turns.at(-1);
    if (turn) this.runner.note(session, turn, { kind: 'goal', label });
  }
}

// A checker's reply as a verdict: { verdict, why, next, progress, tests }, or null when it said
// nothing usable. A "met" needs what the checker saw for itself, and tests that don't disagree.
function readVerdict(j, tests) {
  if (!j || !VERDICTS.has(j.verdict)) return null;
  const progress = Number(j.progress);
  const failing = tests?.verdict === 'fail';
  const evidence = Array.isArray(j.evidence) ? j.evidence.filter((e) => typeof e === 'string' && e.trim()) : [];
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

function checkPrompt(s, turn, g, { tests, diff, judge }) {
  const hero = heroOf(turn.presentation);
  const history = g.checks.slice(-4).map((c) => `- round ${c.round}: ${c.verdict}: ${c.why}`).join('\n');
  return `You check whether a coding agent reached its goal.${judge ? ` You are ${judge.name}${judge.role ? ` (${judge.role})` : ''}, ${judge.n > 1 ? `one of ${judge.n} judges who each check on their own; the goal counts as met only if enough of you agree` : 'the judge of this goal'}.` : ''} Your working directory is the project it works in: open the files, read the code, look at git status and diffs. Don't take the agent's word for anything you can check yourself.

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
<agent-claim round="${g.round}">
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
    `wisp checked your work against the goal and it isn't met yet (round ${g.round} starts now).`,
    `Goal: ${g.text}`,
    c.tally ? `Judges: ${c.tally}.` : '',
    `What's missing: ${c.why}`,
    c.next ? `Next: ${c.next}` : '',
    'Keep working until the goal is met, and check it yourself before you finish. If it turns out it can’t be done, stop and say exactly why, with the hero’s status "blocked".',
  ]
    .filter(Boolean)
    .join('\n\n');
}
