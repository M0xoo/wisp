// Auto: wisp picks harness, model and thinking level per task and learns from outcomes (server/router.js).
// This wires the router to the rest of the server: which harnesses are installed here, the
// user's Auto settings, and the outcome signals that come back from summaries.

import fs from 'node:fs';
import { listAgents } from '../adapters/index.js';
import { GOALS, classify } from '../router.js';
import { createWorktree, repoRoot } from '../git.js';
import { Pipeline, autoSettings } from '../pipeline.js';
import { scanProject, scoutTask } from '../scout.js';
import { summarize } from '../runner.js';
import { bad, newId } from '../util.js';

export function createAuto(app) {
  const { store, router } = app;
  let agentsHere = [];
  let detecting = 0;

  // The latest detection wins: an older one still running (with what it read before a sign-in)
  // doesn't overwrite a newer answer when it finishes.
  const detect = async (opts) => {
    const n = ++detecting;
    const agents = await listAgents(opts);
    if (n < detecting) return agentsHere.length ? agentsHere : agents;
    agentsHere = agents;
    const added = router.sync(agents);
    if (added.length) app.broadcast('router', { added });
    return agents;
  };
  // This computer's harnesses: the last ones detected, else detected now.
  const agents = async () => (agentsHere.length ? agentsHere : await detect());
  // What the page asks for on every load: the last detection right away, checked again in the
  // background (a cold probe takes seconds: opencode lists its models), and an 'agents' event
  // if that changed anything, so the launcher never waits on it.
  const listed = async () => {
    if (!agentsHere.length) return detect();
    const before = JSON.stringify(agentsHere);
    detect()
      .then((now) => JSON.stringify(now) !== before && app.broadcast('agents', {}))
      .catch(() => {});
    return agentsHere;
  };

  const opts = () => {
    const r = store.config.defaults.router || {};
    return { explore: r.explore !== 'off', allowed: Array.isArray(r.allowed) && r.allowed.length ? r.allowed : null };
  };
  // The allowed harnesses narrow Auto's pick wherever one of them can run. A place that has none of
  // them (a machine with other harnesses signed in) gets what it has: the list is set on this
  // computer, from its harnesses, and shouldn't make Auto refuse to run anywhere else.
  const allowedAt = (agents) => {
    const { allowed } = opts();
    return allowed && agents.some((a) => a.available && allowed.includes(a.id)) ? allowed : null;
  };
  const goalOf = (model) => (GOALS[model] ? model : GOALS[store.config.defaults.models?.auto] ? store.config.defaults.models.auto : 'balanced');

  // Subagents set to Auto are routed on their first task, from this computer's harnesses.
  app.runner.routeAuto = (prompt) => router.choose({ prompt, agents: agentsHere, goal: goalOf(), ...opts(), allowed: allowedAt(agentsHere) });

  // A routed session's outcome so far, from its summary: works the same for sessions on machines.
  // Follow-ups after the first turn count as corrections; a merged or closed PR settles it, unless
  // the user moved the task to another harness or model first.
  const signals = (sum) => {
    if (!sum?.id || !router.route(sum.id) || sum.status === 'running' || sum.state === 'running') return;
    const pr = sum.pr?.state;
    router.signal(sum.id, {
      hero: ['done', 'partial', 'blocked', 'info'].includes(sum.status) ? sum.status : undefined,
      followups: sum.followups ?? Math.max(0, (sum.turnCount || 1) - 1),
      check: sum.auto?.check?.verdict && sum.auto.check.verdict !== 'skip' ? sum.auto.check.verdict : undefined,
      merged: pr === 'MERGED' || undefined,
      closed: pr === 'CLOSED' || undefined,
      switched: sum.route?.switched || undefined,
    });
  };

  // agent 'auto' (and compare entries set to it) → a harness, model and thinking level picked by the router from
  // `agents`: this computer's, or the machine's the launch goes to. Model is the goal for Auto.
  // cwd (launches here only): the scout looks at it first, and best-of-2 needs it to be a repo.
  // place: the machine's name, for a launch there.
  const resolve = async (body, agents, { team = false, cwd = null, place = '' } = {}) => {
    const want = [{ agent: body.agent, model: body.model, effort: body.effort }, ...(Array.isArray(body.compare) ? body.compare : [])];
    if (!want.some((r) => r.agent === 'auto')) return body;
    // A machine's harnesses and models join the router's arms too, or the ones only it has would
    // stay on probation (rarely picked) for good. Nothing of this computer's is marked gone.
    if (place) {
      const added = router.sync(agents, { more: true });
      if (added.length) app.broadcast('router', { added });
    }
    const allowed = allowedAt(agents);
    const set = autoSettings(store.config.defaults);
    // The scout: the scan is free; the cheap-model look runs for bigger tasks, every task, or never.
    let scout = null;
    if (cwd) {
      const scan = scanProject(cwd, store.projectFor(cwd));
      scout = { testCommand: scan.tests?.command || '', languages: scan.languages };
      const big = classify(body.prompt).size !== 'S' || String(body.prompt).length > 400;
      if (set.scout === 'all' || (set.scout === 'big' && big)) {
        const found = await scoutTask({ prompt: body.prompt, cwd, agents, scan }).catch(() => null);
        if (found) Object.assign(scout, found, { by: 'model' });
      }
    }
    // Best-of-2: the Best goal (or an important task) gets two different picks side by side, each
    // in its own worktree, and wisp marks the better one once both are checked.
    const goal = goalOf(want[0].model);
    const best2 = !!cwd && set.best2 && want.length === 1 && want[0].agent === 'auto' && (goal === 'best' || !!body.important) && !team && !!(await repoRoot(cwd).catch(() => null));
    if (best2) want.push({ agent: 'auto', model: want[0].model });
    const taken = [];
    const out = want
      .map((r, i) => {
        if (r.agent !== 'auto') return r;
        const pick = router.choose({ prompt: body.prompt, attachments: (body.attachments || []).length, agents, goal: goalOf(r.model), important: !!body.important || (best2 && i === 0), exclude: taken, needDelegate: i === 0 && team, scouted: scout?.by ? scout : null, ...opts(), allowed });
        if (!pick) {
          if (best2 && i === 1) return null; // only one option to pick from: a single run then
          throw bad(place ? `Auto found no harness installed and signed in on ${place}. Sign in to one there (Run with → pick it).` : 'Auto found no installed harness to run this on.');
        }
        taken.push(pick.key);
        return { agent: pick.agent, model: pick.model, effort: pick.effort, route: pick.route };
      })
      .filter(Boolean);
    const autoStrategy = best2 && out.length === 2 ? 'best2' : out.length > 1 ? 'compare' : 'single';
    return { ...body, ...out[0], compare: out.slice(1), scout, autoStrategy };
  };

  // Escalation: the same task again on a stronger pick, in its own worktree from the same base,
  // next to the first run (one task, two rows).
  // reason: 'tests' | 'error' (a hand-over to a stronger pick) or 'limit' (the harness was at its
  // usage limit: the new run is a fresh start that may still repair and hand over itself).
  const launchSibling = async (s, pick, { reason = 'tests', tried = [] } = {}) => {
    const first = s.turns[0];
    const id = newId();
    if (!s.groupId) s.groupId = newId();
    const fresh = (wt, cwd) => (wt ? createWorktree({ cwd, home: store.home, id, title: first.prompt, source: { root: wt.root, base: { ref: wt.head || wt.baseRef, branch: wt.base, remote: wt.remote, sha: wt.head } } }).catch(() => null) : null);
    const worktree = await fresh(s.worktree, s.cwd);
    // The task's other folders too: fresh worktrees from the same bases.
    const also = await Promise.all(
      (s.also || []).map(async (a) => {
        const tree = await fresh(a.worktree, a.cwd);
        return tree ? { cwd: a.cwd, worktree: tree } : { cwd: a.cwd };
      }),
    );
    const sib = app.runner.create({
      id,
      prompt: first.prompt,
      cwd: s.cwd,
      also,
      agent: pick.agent,
      model: pick.model,
      effort: pick.effort || '',
      mode: s.mode,
      attachments: app.uploads.resolve((first.attachments || []).map((a) => a.id)),
      worktree,
      groupId: s.groupId,
      origin: s.origin || null,
      subagents: s.subagents || [],
      route: { ...pick.route, escalated: reason !== 'limit', ...(reason === 'limit' && { moved: true }) },
      auto: { strategy: reason === 'limit' ? s.auto?.strategy || 'single' : 'escalated', escalatedFrom: s.id, reason, tried: [...new Set([...tried, ...(s.auto?.tried || []), s.route?.key].filter(Boolean))] },
      scout: s.scout || null,
    });
    // Now one task with two runs: it's named after the prompt, like a compare task.
    if (s.titleAuto) s.title = sib.title;
    app.sessionChanged(s);
    return sib;
  };

  // Auto's steps after a run: check with the tests, repair, hand over, judge best-of-2.
  const pipeline = new Pipeline({
    store,
    runner: app.runner,
    router,
    settings: () => autoSettings(store.config.defaults),
    agents: () => agentsHere,
    projectOf: (s) => store.projectFor(s.cwd),
    launchSibling,
    broadcast: (e, d) => app.broadcast(e, d),
    summarize: (s) => summarize(s, store),
    onSettled: (s) => {
      signals(summarize(s, store));
      const a = s.auto;
      const c = a.checks.at(-1);
      app.telemetry.track('auto_settled', { strategy: a.strategy, verdict: c?.verdict || 'none', repairs: a.repairs, escalated: !!a.escalatedTo, escalation: !!a.escalatedFrom, checkMs: c?.durationMs, routeType: s.route?.type });
    },
  });
  app.runner.pipeline = pipeline;

  // The test command per project (here only), for the Auto view.
  const projects = () =>
    store.config.projects
      .filter((p) => !p.machine && fs.existsSync(p.path))
      .map((p) => ({ id: p.id, name: p.name, color: p.color, testCommand: p.testCommand || '', detected: scanProject(p.path, { ...p, testCommand: '' }).tests }));

  // What the Auto view shows: goals, settings, and what the router learned.
  const view = async () => ({ goals: GOALS, goal: goalOf(), settings: { explore: opts().explore, allowed: opts().allowed, ...autoSettings(store.config.defaults) }, projects: projects(), ...router.report(await agents()) });

  return { detect, agents, listed, opts, goalOf, signals, resolve, view };
}
