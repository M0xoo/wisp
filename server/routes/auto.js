// Auto: what the router learned, and its settings (goal, trying new models, allowed harnesses).

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
    app.configChanged();
    c.send(200, await auto.view());
  });
  r.route('POST', '/router/reset', async (c) => {
    app.router.reset();
    app.broadcast('router', {});
    c.send(200, await auto.view());
  });
}
