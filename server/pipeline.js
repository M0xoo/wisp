// What Auto does after the agent says it's done, before the task lands in your queue:
//
//   check     wisp runs the project's tests itself (server/check.js). Only new failures count.
//   repair    tests fail → the same session gets the failures back, up to `repairs` rounds.
//   escalate  still failing (or the run errored) → the same model thinking harder (a run at low or
//             medium), else a stronger harness · model,
//             in its own worktree, next to the first run (one task, two rows).
//   judge     best-of-2 (goal Best): both runs are checked, then the better one is marked
//             (server/judge.js): tests first, then a cheap model reading both diffs.
//
// The turn's presentation gets wisp's own tests block, and when the agent said "all green" but
// wisp's run disagrees, a callout saying so. The router learns from the verdicts.
//
// State lives on the session as `auto`: { strategy, busy, stage, label, repairs, checks[],
// escalatedTo, escalatedFrom, pick }. The runner keeps a session in Working while `busy`.

import { check as runCheck } from './check.js';
import { judge, diffOf } from './judge.js';
import { workdir } from './runner.js';
import { infraError, tierOf } from './router.js';

// What an errored turn said (the terminal block the runner puts on it).
const errorText = (turn) => (turn.presentation?.blocks || []).filter((b) => b.type === 'terminal').map((b) => b.output || '').join('\n');
const MAX_MOVES = 4; // a task moved this many times because harnesses were at their limit stops there

export const AUTO_DEFAULTS = { check: 'on', repairs: 1, escalate: 'on', best2: 'off', scout: 'big' };

export function autoSettings(d = {}) {
  const r = d.router || {};
  return {
    check: r.check !== 'off',
    repairs: [0, 1, 2].includes(Number(r.repairs)) ? Number(r.repairs) : AUTO_DEFAULTS.repairs,
    escalate: r.escalate !== 'off',
    best2: r.best2 === 'on', // opt-in: it runs every Best task twice
    scout: ['off', 'big', 'all'].includes(r.scout) ? r.scout : AUTO_DEFAULTS.scout,
  };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Pipeline {
  // deps: { store, runner, router, settings(), agents(), projectOf(session), launchSibling(session, pick),
  //         onSettled(session), broadcast(event, data) }
  constructor(deps) {
    Object.assign(this, deps);
    this.tokens = new Map(); // sessionId -> token of the step in flight; a user's move cancels it
  }

  // Called by the runner as a turn ends: true keeps the session in Working while wisp checks.
  wants(session, turn, ev) {
    const a = session.auto;
    if (!a || session.parentId || ev.stopped || session.mode === 'plan') return false;
    const s = this.settings();
    // At its limit: not the model's fault, so the task moves on whatever the hand-over setting says.
    if (ev.isError) return !!infraError(ev.text) || (s.escalate && this.#canEscalate(session));
    return s.check;
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
      let result;
      const limit = turn.status === 'error' && infraError(errorText(turn));
      if (limit) return await this.#moveOn(session, turn, limit, live);
      if (turn.status === 'error') result = { verdict: 'error' };
      else {
        this.#stage(session, turn, 'checking', 'Checking with the tests');
        result = await runCheck({ dir: workdir(session), project: this.projectOf(session), worktree: session.worktree });
        if (!live()) return;
        a.checks.push({ turnId: turn.id, ...result, output: undefined });
        this.#present(session, turn, result);
      }
      this.router.signal(session.id, { check: result.verdict, repaired: a.repairs > 0 || undefined });

      const failing = result.verdict === 'fail' || result.verdict === 'error';
      // Repairs and hand-overs are for the task as you sent it: once you've followed up yourself,
      // wisp still checks and shows the result, but leaves the next move to you.
      const yours = session.turns.some((t, i) => i > 0 && t.by !== 'wisp');
      if (result.verdict === 'fail' && a.repairs < s.repairs && !yours) {
        a.repairs++;
        this.#stage(session, turn, 'repairing', `Fixing ${plural(result.newFailures.length || result.failed || 1, 'failing test')}`);
        this.runner.reply(session, repairPrompt(result, a.repairs, s.repairs), [], { by: 'wisp' });
        return; // the repair turn comes back through wants()/run()
      }
      if (failing && s.escalate && this.#canEscalate(session)) {
        // A step up: a stronger tier than this run's (or the strongest there is, if it was already top).
        const tier = tierOf(session.route?.key || '');
        // A run that thought low or medium goes again at high on the same model first: cheaper
        // than a stronger model, and it solves most of what the low run missed.
        const pick = (!(a.tried || []).length && this.router.levelUp?.(session.route, this.agents())) || this.router.choose({ prompt: session.turns[0].prompt, agents: this.agents(), goal: 'best', important: true, minTier: Math.min(3, tier + 1), exclude: [session.route?.key, ...(a.tried || [])].filter(Boolean), needDelegate: !!session.subagents?.length });
        if (!pick || tierOf(pick.key) < tier) this.#note(session, turn, 'check', 'No stronger harness · model to hand it to');
        else {
          this.#stage(session, turn, 'escalating', `Handing it to ${pick.label}`);
          const sib = await this.launchSibling(session, pick, { reason: result.verdict === 'error' ? 'error' : 'tests' });
          if (!live()) return;
          a.escalatedTo = sib.id;
          a.reason = result.verdict === 'error' ? 'error' : 'tests';
          this.#note(session, turn, 'check', `wisp handed this task to ${pick.label}: ${result.verdict === 'error' ? 'the run ended with an error' : 'the tests still fail'}`);
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

  // wisp's tests block goes right under the hero; a "done" that wisp's run contradicts is called out.
  #present(session, turn, r) {
    const blocks = turn.presentation?.blocks;
    if (!blocks) return;
    const label = `${r.command ? `\`${r.command}\`` : 'the tests'}`;
    if (r.verdict === 'skip') {
      this.#note(session, turn, 'check', `No tests to run: ${r.reason}`);
      return;
    }
    const failures = (r.newFailures.length ? r.newFailures : r.verdict === 'fail' ? ['(see output)'] : []).slice(0, 8).map((name) => ({ name, message: '' }));
    const block = { type: 'tests', by: 'wisp', command: r.command, passed: r.passed ?? undefined, failed: r.verdict === 'pass' ? 0 : r.newFailures.length || r.failed, skipped: r.skipped ?? undefined, durationMs: r.durationMs, failures, note: r.note || undefined };
    if (r.verdict === 'pass' && block.passed == null) block.passed = 1;
    const at = Math.max(0, blocks.findIndex((b) => b.type === 'hero') + 1);
    blocks.splice(at, 0, block);
    const hero = blocks.find((b) => b.type === 'hero');
    const claimed = blocks.some((b) => b.type === 'tests' && b.by !== 'wisp' && !(Number(b.failed) > 0)) || hero?.status === 'done';
    if (r.verdict === 'fail') {
      if (hero && hero.status === 'done') (hero.agentStatus = hero.status), (hero.status = 'partial');
      if (claimed) blocks.splice(at + 1, 0, { type: 'callout', tone: 'danger', by: 'wisp', title: "wisp's test run disagrees", text: `The agent reported this as done, but ${label} has ${plural(r.newFailures.length || r.failed, 'failing test')} that passed before the change.` });
    }
    this.#note(session, turn, 'check', r.verdict === 'pass' ? `Tests pass: ${label}${r.note ? ` (${r.note})` : ''}` : r.verdict === 'fail' ? `Tests fail: ${plural(r.newFailures.length || r.failed, 'new failure')} in ${label}` : `Tests inconclusive: ${r.note || label}`);
    this.store.save(session);
    this.broadcast('turn', { sessionId: session.id, turnId: turn.id });
  }

  // Best-of-2: once both runs have settled, mark the better one.
  async #judgeGroup(session) {
    const group = this.store.all().filter((x) => x.groupId === session.groupId && x.auto?.strategy === 'best2');
    if (group.length < 2 || group.some((x) => x.auto.busy || x.state === 'running') || group.some((x) => x.auto.pick)) return;
    group.forEach((x) => (x.auto.pick = { pending: true }));
    const candidates = group.slice(0, 2).map((x) => ({ id: x.id, label: x.route?.label || x.agent, check: x.auto.checks.at(-1), diff: diffOf(workdir(x), x.worktree?.head || 'HEAD') }));
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

function repairPrompt(r, round, max) {
  const list = r.newFailures.length ? r.newFailures.slice(0, 20).map((t) => `- ${t}`).join('\n') : '';
  return [
    `wisp ran \`${r.command}\` on your change and it fails${list ? ':' : '.'}`,
    list,
    r.output ? `Output (tail):\n\`\`\`\n${r.output.slice(-3500)}\n\`\`\`` : '',
    'These tests passed before your change. Fix the code so they pass again: do not delete, skip or weaken tests. Run the tests yourself, then finish with an updated presentation.',
    max > 1 ? `(Repair round ${round} of ${max}.)` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
