// Auto: what the router learned, and its settings (goal, trying new models, allowed harnesses,
// and the steps after a run: check, repairs, hand-over, best of two, scout).

import { adapters } from '../adapters/index.js';
import { GOALS, TYPES } from '../router.js';

const RULE = /^[\w-]+(:[\w./-]*(:[\w-]+)?)?(@[a-z]+)?$/;

export function register(r, app) {
  const { store, auto } = app;

  r.route('GET', '/router', async (c) => c.send(200, await auto.view()));
  r.route('PATCH', '/router', async (c) => {
    const body = await c.body();
    const d = store.config.defaults;
    if (body.goal !== undefined) {
      if (!GOALS[body.goal]) return c.send(400, { error: `goal must be one of ${Object.keys(GOALS).join(', ')}` });
      d.models = { ...d.models, auto: body.goal };
      if (d.agent === 'auto') d.model = body.goal;
    }
    d.router = { ...d.router };
    if (body.explore !== undefined) d.router.explore = body.explore ? 'on' : 'off';
    if (body.allowed !== undefined) d.router.allowed = Array.isArray(body.allowed) ? body.allowed.filter((a) => adapters[a]) : null;
    for (const k of ['escalate', 'best2', 'habits']) if (body[k] !== undefined) d.router[k] = body[k] ? 'on' : 'off';
    // Never pick / Prefer: 'claude', 'claude:sonnet', 'claude:sonnet:high', optionally '…@ui'.
    for (const k of ['blocked', 'prefer']) {
      if (body[k] === undefined) continue;
      if (!Array.isArray(body[k])) return c.send(400, { error: `${k} must be a list` });
      const bad = body[k].find((x) => typeof x !== 'string' || !RULE.test(x) || !adapters[x.split(/[:@]/)[0]] || (x.includes('@') && !TYPES.includes(x.split('@')[1])));
      if (bad !== undefined) return c.send(400, { error: `${k}: "${bad}" isn't a harness, harness:model or harness:model:level (optionally @kind, one of ${TYPES.join(', ')})` });
      d.router[k] = [...new Set(body[k])].slice(0, 60);
    }
    if (body.scout !== undefined) {
      if (!['off', 'big', 'all'].includes(body.scout)) return c.send(400, { error: 'scout must be off, big or all' });
      d.router.scout = body.scout;
    }
    app.configChanged();
    c.send(200, await auto.view());
  });
  // What Auto would run for a prompt, shown in the launcher before you send it.
  // body: { prompt, attachments (a count), goal, team, machine ('' or absent: this computer) }.
  r.route('POST', '/router/preview', async (c) => {
    const body = await c.body();
    const prompt = String(body.prompt || '').slice(0, 20_000);
    const mid = typeof body.machine === 'string' && body.machine ? app.machines.get(body.machine)?.id : null;
    const agents = mid ? app.machines.agentsOf(mid) || [] : await auto.agents();
    const place = mid ? app.machines.get(mid).name : '';
    c.send(200, await auto.preview({ prompt, attachments: Math.max(0, Number(body.attachments) || 0), goal: body.goal, team: !!body.team }, agents, { place }));
  });
  r.route('POST', '/router/reset', async (c) => {
    app.router.reset();
    app.broadcast('router', {});
    c.send(200, await auto.view());
  });
}
