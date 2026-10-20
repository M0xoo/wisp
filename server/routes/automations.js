// Recipes (saved prompts with {params}) and triggers (schedules and GitHub watchers).

import { normalizeRecipe, findRecipe, recipeView } from '../recipes.js';
import { normalizeTrigger, triggerView } from '../triggers.js';

export function register(r, app) {
  const { store } = app;

  // Yours, then the ones spells add (read-only: they belong to the spell).
  const all = () => [...store.config.recipes, ...app.spells.recipes()];
  r.route('GET', '/recipes', (c) => c.send(200, all().map(recipeView)));
  r.route('POST', '/recipes', async (c) => {
    const x = normalizeRecipe(await c.body());
    store.config.recipes.push(x);
    app.configChanged();
    c.send(201, recipeView(x));
  });
  // A recipe by id or by name (loosely: "Fix Bug" finds fix-bug).
  const recipe = (fn, { mine = false } = {}) => async (c) => {
    const x = findRecipe(all(), c.params.key);
    if (!x) return c.send(404, { error: 'no such recipe' });
    if (mine && x.spell) return c.send(409, { error: `This recipe comes from the spell ${x.spell.name}; change the spell instead.` });
    return fn(c, x);
  };
  r.route('GET', '/recipes/:key', recipe((c, x) => c.send(200, recipeView(x))));
  r.route(
    'PATCH',
    '/recipes/:key',
    recipe(async (c, x) => {
      Object.assign(x, normalizeRecipe(await c.body(), x));
      app.configChanged();
      c.send(200, recipeView(x));
    }, { mine: true }),
  );
  r.route(
    'DELETE',
    '/recipes/:key',
    recipe((c, x) => {
      store.config.recipes = store.config.recipes.filter((y) => y !== x);
      app.configChanged();
      c.send(200, { ok: true });
    }, { mine: true }),
  );
  // POST /recipes/:key/run { params | words, cwd, … }. machine: run it in a project there
  // (r.cwd empty, or a path on that machine).
  r.route(
    'POST',
    '/recipes/:key/run',
    recipe(async (c, x) => {
      const body = await c.body();
      const s = await app.launcher.runRecipe(x, { params: body.params || {}, words: Array.isArray(body.words) ? body.words.map(String) : undefined, cwd: body.cwd, machine: body.machine || undefined, agent: body.agent, model: body.model, effort: body.effort, mode: body.mode });
      c.send(201, s);
    }),
  );

  r.route('GET', '/triggers', (c) => c.send(200, store.config.triggers.map(triggerView)));
  r.route('POST', '/triggers', async (c) => {
    const t = normalizeTrigger(await c.body(), null, { recipes: store.config.recipes });
    store.config.triggers.push(t);
    app.configChanged();
    c.send(201, triggerView(t));
  });
  const trigger = (fn) => async (c) => {
    const t = store.config.triggers.find((x) => x.id === c.params.id);
    if (!t) return c.send(404, { error: 'no such trigger' });
    return fn(c, t);
  };
  r.route(
    'PATCH',
    '/triggers/:id',
    trigger(async (c, t) => {
      Object.assign(t, normalizeTrigger(await c.body(), t, { recipes: store.config.recipes }));
      app.configChanged();
      c.send(200, triggerView(t));
    }),
  );
  r.route(
    'DELETE',
    '/triggers/:id',
    trigger((c, t) => {
      store.config.triggers = store.config.triggers.filter((x) => x !== t);
      app.configChanged();
      c.send(200, { ok: true });
    }),
  );
  r.route(
    'POST',
    '/triggers/:id/run',
    trigger(async (c, t) => {
      const out = await app.triggers.runNow(t);
      const started = Array.isArray(out) ? out : out ? [out] : [];
      c.send(200, { started, trigger: triggerView(t) });
    }),
  );
}
