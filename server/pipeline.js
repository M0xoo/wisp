// What Auto does after the agent says it's done, before the task lands in your queue:
//
//   escalate  the run errored → the same model thinking harder (a run at low or medium), else a
//             stronger harness · model, in its own worktree, next to the first run (one task, two rows).
//   move on   the harness was at its usage limit → the best pick that can run now.
//   judge     best-of-2 (goal Best): once both runs are done, the better one is marked
//             (server/judge.js): a cheap model reading both diffs.
//
// wisp doesn't run the tests itself after a run: the agent does. The router learns from the outcomes.
//
// State lives on the session as `auto`: { strategy, busy, stage, label, escalatedTo, escalatedFrom,
// pick }. The runner keeps a session in Working while `busy`.

import { judge, diffOf } from './judge.js';
import { workdir } from './runner.js';
import { infraError, tierOf } from './router.js';

// What an errored turn said (the terminal block the runner puts on it).
const errorText = (turn) => (turn.presentation?.blocks || []).filter((b) => b.type === 'terminal').map((b) => b.output || '').join('\n');
const MAX_MOVES = 4; // a task moved this many times because harnesses were at their limit stops there

export const AUTO_DEFAULTS = { escalate: 'on', best2: 'off', scout: 'big' };

export function autoSettings(d = {}) {
  const r = d.router || {};
  return {
    escalate: r.escalate !== 'off',
    best2: r.best2 === 'on', // opt-in: it runs every Best task twice
    scout: ['off', 'big', 'all'].includes(r.scout) ? r.scout : AUTO_DEFAULTS.scout,
  };
}

export class Pipeline {
  // deps: { store, runner, router, settings(), agents(), projectOf(session), launchSibling(session, pick),
  //         onSettled(session), broadcast(event, data) }
  constructor(deps) {
    Object.assign(this, deps);
    this.tokens = new Map(); // sessionId -> token of the step in flight; a user's move cancels it
  }

  // Called by the runner as a turn ends: true keeps the session in Working while wisp moves on.
  wants(session, turn, ev) {
    const a = session.auto;
    if (!a || session.parentId || ev.stopped || session.mode === 'plan') return false;
    // At its limit: not the model's fault, so the task moves on whatever the hand-over setting says.
    if (ev.isError) return !!infraError(ev.text) || (this.settings().escalate && this.#canEscalate(session));
    return a.strategy === 'best2';
  }

  // A follow-up or Stop from the user: whatever wisp was about to do is off.
  cancel(session) {
    if (!session.auto?.busy) return;
    this.tokens.delete(session.id);
    Object.assign(session.auto, { busy: false, stage: 'cancelled', label: '' });
  }

  async run(session, turn) {
    const a = session.auto;
    const token = Symbol('step');
    this.tokens.set(session.id, token);
    const live = () => this.tokens.get(session.id) === token && this.store.get(session.id) === session;
    const s = this.settings();
    try {
      const limit = turn.status === 'error' && infraError(errorText(turn));
      if (limit) return await this.#moveOn(session, turn, limit, live);
      if (turn.status === 'error' && s.escalate && this.#canEscalate(session)) {
        // A step up: a stronger tier than this run's (or the strongest there is, if it was already top).
        const tier = tierOf(session.route?.key || '');
        // A run that thought low or medium goes again at high on the same model first: cheaper
        // than a stronger model, and it solves most of what the low run missed.
        const pick = (!(a.tried || []).length && this.router.levelUp?.(session.route, this.agents())) || this.router.choose({ prompt: session.turns[0].prompt, agents: this.agents(), goal: 'best', important: true, minTier: Math.min(3, tier + 1), exclude: [session.route?.key, ...(a.tried || [])].filter(Boolean), needDelegate: !!session.subagents?.length });
        if (!pick || tierOf(pick.key) < tier) this.#note(session, turn, 'check', 'No stronger harness · model to hand it to');
        else {
          this.#stage(session, turn, 'escalating', `Handing it to ${pick.label}`);
          const sib = await this.launchSibling(session, pick, { reason: 'error' });
          if (!live()) return;
          a.escalatedTo = sib.id;
          a.reason = 'error';
          this.#note(session, turn, 'check', `wisp handed this task to ${pick.label}: the run ended with an error`);
          return this.#settle(session, { quiet: true });
        }
      }
      this.#settle(session);
      if (a.strategy === 'best2') await this.#judgeGroup(session);
    } catch (err) {
      console.warn(`wisp: auto pipeline: ${err.stack || err.message}`);
      if (live()) this.#settle(session);
    }
  }

  // The harness was at a usage or rate limit: the run doesn't count against it, it cools down until
  // the limit resets, and the task moves to the best pick that can run now.
  async #moveOn(session, turn, limit, live) {
    const a = session.auto;
    const why = errorText(turn).split('\n').find((l) => l.trim())?.trim() || 'at its limit';
    const cooled = this.router.cool(session.route?.key || `${session.agent}:${session.model || ''}`, { ...limit, why });
    this.router.void(session.id);
    const name = cooled.endsWith(':*') ? session.route?.label?.split(' · ')[0] || session.agent : session.route?.label || session.agent;
    const tried = [...(a.tried || []), session.route?.key].filter(Boolean);
    const pick = tried.length < MAX_MOVES ? this.router.choose({ prompt: session.turns[0].prompt, agents: this.agents(), goal: session.route?.goal || 'balanced', exclude: tried, needDelegate: !!session.subagents?.length }) : null;
    if (!pick) {
      this.#note(session, turn, 'check', `${name} is at its limit, and nothing else Auto may use can run right now`);
      return this.#settle(session);
    }
    this.#stage(session, turn, 'moving', `${name} is at its limit · moving to ${pick.label}`);
    const sib = await this.launchSibling(session, pick, { reason: 'limit', tried });
    if (!live()) return;
    a.escalatedTo = sib.id;
    a.reason = 'limit';
    return this.#settle(session, { quiet: true });
  }

  // Escalate once per task, and only while the user hasn't stepped in with follow-ups.
  #canEscalate(session) {
    const a = session.auto;
    // A fresh worktree from the same base, or the second run would build on the first one's mess.
    return a.strategy === 'single' && !a.escalatedTo && !!session.worktree && !session.turns.some((t, i) => i > 0 && t.by !== 'wisp');
  }

  #stage(session, turn, stage, label) {
    Object.assign(session.auto, { busy: true, stage, label });
    this.#note(session, turn, 'check', `${label}…`);
  }

  #note(session, turn, kind, label) {
    this.runner.note(session, turn, { kind, label });
  }

  #settle(session, { quiet = false } = {}) {
    this.tokens.delete(session.id);
    Object.assign(session.auto, { busy: false, stage: 'done', label: '' });
    this.runner.settle(session, { quiet });
    this.onSettled?.(session);
  }

  // Best-of-2: once both runs have settled, mark the better one.
  async #judgeGroup(session) {
    const group = this.store.all().filter((x) => x.groupId === session.groupId && x.auto?.strategy === 'best2');
    if (group.length < 2 || group.some((x) => x.auto.busy || x.state === 'running') || group.some((x) => x.auto.pick)) return;
    group.forEach((x) => (x.auto.pick = { pending: true }));
    const candidates = group.slice(0, 2).map((x) => ({ id: x.id, label: x.route?.label || x.agent, diff: diffOf(workdir(x), x.worktree?.head || 'HEAD') }));
    const j = await judge({ prompt: group[0].turns[0].prompt, candidates, agents: this.agents() });
    for (const x of group) {
      x.auto.pick = { winner: x.id === j.winner, why: j.why, by: j.by };
      this.store.save(x);
      this.broadcast('summary', this.summarize(x));
    }
    const w = group.find((x) => x.id === j.winner);
    if (w) this.#note(w, w.turns.at(-1), 'check', `wisp's pick of the two runs: ${j.why}`);
    for (const x of group) this.router.signal(x.id, { picked: x.id === j.winner });
  }
}
