// Auto: wisp picks harness and model per task and learns from outcomes (server/router.js).
// This wires the router to the rest of the server: which harnesses are installed here, the
// user's Auto settings, and the outcome signals that come back from summaries.

import { listAgents } from '../adapters/index.js';
import { GOALS } from '../router.js';
import { bad } from '../util.js';

export function createAuto(app) {
  const { store, router } = app;
  let agentsHere = [];

  const detect = async (opts) => {
    const agents = await listAgents(opts);
    agentsHere = agents;
    const added = router.sync(agents);
    if (added.length) app.broadcast('router', { added });
    return agents;
  };
  // This computer's harnesses: the last ones detected, else detected now.
  const agents = async () => (agentsHere.length ? agentsHere : await detect());

  const opts = () => {
    const r = store.config.defaults.router || {};
    return { explore: r.explore !== 'off', allowed: Array.isArray(r.allowed) && r.allowed.length ? r.allowed : null };
  };
  const goalOf = (model) => (GOALS[model] ? model : GOALS[store.config.defaults.models?.auto] ? store.config.defaults.models.auto : 'balanced');

  // Subagents set to Auto are routed on their first task, from this computer's harnesses.
  app.runner.routeAuto = (prompt) => router.choose({ prompt, agents: agentsHere, goal: goalOf(), ...opts() });

  // A routed session's outcome so far, from its summary: works the same for sessions on machines.
  // Follow-ups after the first turn count as corrections; a merged or closed PR settles it, unless
  // the user moved the task to another harness or model first.
  const signals = (sum) => {
    if (!sum?.id || !router.route(sum.id) || sum.status === 'running' || sum.state === 'running') return;
    const pr = sum.pr?.state;
    router.signal(sum.id, {
      hero: ['done', 'partial', 'blocked', 'info'].includes(sum.status) ? sum.status : undefined,
      followups: Math.max(0, (sum.turnCount || 1) - 1),
      merged: pr === 'MERGED' || undefined,
      closed: pr === 'CLOSED' || undefined,
      switched: sum.route?.switched || undefined,
    });
  };

  // agent 'auto' (and compare entries set to it) → a harness and model picked by the router from
  // `agents`: this computer's, or the machine's the launch goes to. Model is the goal for Auto.
  const resolve = async (body, agents, { team = false } = {}) => {
    const want = [{ agent: body.agent, model: body.model, effort: body.effort }, ...(Array.isArray(body.compare) ? body.compare : [])];
    if (!want.some((r) => r.agent === 'auto')) return body;
    const taken = [];
    const out = want.map((r, i) => {
      if (r.agent !== 'auto') return r;
      const pick = router.choose({ prompt: body.prompt, attachments: (body.attachments || []).length, agents, goal: goalOf(r.model), important: !!body.important, exclude: taken, needDelegate: i === 0 && team, ...opts() });
      if (!pick) throw bad('Auto found no installed harness to run this on.');
      taken.push(pick.key);
      return { agent: pick.agent, model: pick.model, effort: '', route: pick.route };
    });
    return { ...body, ...out[0], compare: out.slice(1) };
  };

  // What the Auto view shows: goals, settings, and what the router learned.
  const view = async () => ({ goals: GOALS, goal: goalOf(), settings: { explore: opts().explore, allowed: opts().allowed }, ...router.report(await agents()) });

  return { detect, agents, opts, goalOf, signals, resolve, view };
}
