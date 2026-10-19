// Auto: what the router learned, and its settings (goal, trying new models, allowed harnesses,
// and the steps after a run: check, repairs, hand-over, best of two, scout).

import { adapters } from '../adapters/index.js';
import { GOALS } from '../router.js';

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
    for (const k of ['check', 'escalate', 'best2']) if (body[k] !== undefined) d.router[k] = body[k] ? 'on' : 'off';
    if (body.repairs !== undefined) d.router.repairs = Math.max(0, Math.min(2, Math.round(Number(body.repairs)) || 0));
    if (body.scout !== undefined) {
      if (!['off', 'big', 'all'].includes(body.scout)) return c.send(400, { error: 'scout must be off, big or all' });
      d.router.scout = body.scout;
    }
    app.configChanged();
    c.send(200, await auto.view());
  });
  r.route('POST', '/router/reset', async (c) => {
    app.router.reset();
    app.broadcast('router', {});
    c.send(200, await auto.view());
  });
}
