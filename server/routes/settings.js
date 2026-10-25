// Settings: the config, what wisp learned, subagent presets, the phone, and projects.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { KINDS } from '../preferences.js';
import { normalizePreset } from '../subagents.js';
import { envDisabled, feedbackAvailable } from '../telemetry.js';
import { CHANNELS } from '../update.js';
import { defaultTerminal, inWisp, TERMINALS } from '../terminal.js';
import { normalizeWebhooks } from '../services/webhooks.js';
import { cloneRepo, gh, git, parseRepo } from '../git.js';
import { checkout, cloneRoot, discoverRepos, originAt } from '../services/places.js';
import { expand } from '../util.js';
import { triggerView } from '../triggers.js';

// On a wisp Grid (its hostd sets WISP_GRID_URL): the grid, and this wisp's own address there, so
// the page offers connecting through the grid instead of SSH.
// A cloud computer has no terminal app: take over is always in the page there.
const terminals = () => (process.env.WISP_GRID_URL ? TERMINALS.filter((t) => t.id === 'wisp') : TERMINALS);
const gridInfo = (app) => (process.env.WISP_GRID_URL && app.publicUrl ? { url: process.env.WISP_GRID_URL.replace(/\/+$/, ''), address: app.publicUrl } : null);

export { cloneRoot };

export function register(r, app) {
  const { store, telemetry, prefs, retro, remote, machines } = app;

  // defaults are what's in effect: yours, with what spells set on top (lockedBy says which spell).
  // spells: every spell that's on, for the page to apply. recipes: yours and the spells'.
  const view = () => ({
    ...store.config,
    remote: undefined,
    defaults: { ...store.config.defaults },
    lockedBy: app.spells.settings().lockedBy,
    recipes: [...store.config.recipes, ...app.spells.recipes()],
    crew: app.crew ? app.crew.list.map((m) => app.crew.view(m)) : store.config.crew, // with nextAt and what's running
    triggers: store.config.triggers.map(triggerView), // with nextAt, for split home's Coming up
    spells: app.spells.forPage(),
    spellsSafe: app.spells.safe,
  });
  r.route('GET', '/config', (c) =>
    c.send(200, { ...view(), home: os.homedir(), cwd: process.cwd(), cloneDir: cloneRoot(store.config), terminals: terminals(), defaultTerminal: defaultTerminal(), takeoverInline: inWisp(store.config.defaults.terminal || defaultTerminal()), grid: gridInfo(app), telemetry: { available: !envDisabled(), enabled: telemetry.enabled }, feedback: feedbackAvailable() }),
  );
  r.route('PATCH', '/config', async (c) => {
    const body = await c.body();
    const locked = app.spells.settings().lockedBy;
    const clash = Object.keys(body.defaults || {}).find((k) => locked[k] && body.defaults[k] !== store.config.defaults[k]);
    if (clash) return c.send(409, { error: `${clash} is set by the spell ${locked[clash].name}. Turn it off in Settings → Spells to change it.`, spell: locked[clash] });
    if (body.defaults?.updateChannel !== undefined && !Object.hasOwn(CHANNELS, body.defaults.updateChannel)) return c.send(400, { error: `updateChannel must be one of ${Object.keys(CHANNELS).join(', ')}` });
    const channelWas = store.config.defaults.updateChannel;
    if (body.defaults) Object.assign(store.config.defaults, Object.fromEntries(Object.entries(body.defaults).filter(([k]) => !locked[k])));
    if (body.webhooks !== undefined) {
      const { hooks, error } = normalizeWebhooks(body.webhooks);
      if (error) return c.send(400, { error });
      store.config.webhooks = hooks;
    }
    app.configChanged();
    // Another channel offers other releases: look now rather than tomorrow.
    if (store.config.defaults.updateChannel !== channelWas && app.updater?.enabled) app.updater.check();
    c.send(200, view());
  });

  // What wisp learned: preferences and lessons, global and per project (scope = 'global' or a project path).
  const learned = () => ({
    enabled: app.learning(),
    global: prefs.data.global,
    projects: Object.entries(prefs.data.projects).map(([p, v]) => ({ path: p, name: store.projectFor(p)?.name || path.basename(p), ...v })),
    history: prefs.data.history.slice().reverse(),
    running: retro.running,
  });
  r.route('GET', '/preferences', (c) => c.send(200, learned()));
  r.route('PUT', '/preferences', async (c) => {
    const body = await c.body();
    const scope = String(body.scope || '');
    if (scope !== 'global' && !path.isAbsolute(scope)) return c.send(400, { error: 'scope must be "global" or a project path' });
    if (!KINDS.includes(body.kind)) return c.send(400, { error: `kind must be one of ${KINDS.join(', ')}` });
    if (!Array.isArray(body.items)) return c.send(400, { error: 'items must be an array of strings' });
    prefs.set(scope, body.kind, body.items);
    app.broadcast('preferences', {});
    c.send(200, learned());
  });

  // Subagent presets: a saved team (members with harness, model, thinking and "use it for").
  const saved = (c, status, body) => (app.configChanged(), c.send(status, body));
  const team = (c) => store.config.teams.find((x) => x.id === c.params.id);
  r.route('GET', '/teams', (c) => c.send(200, store.config.teams));
  r.route('POST', '/teams', async (c) => {
    const t = normalizePreset(await c.body(), adapters);
    store.config.teams.push(t);
    saved(c, 201, t);
  });
  r.route('GET', '/teams/:id', (c) => {
    const t = team(c);
    if (!t) return c.send(404, { error: 'no such preset' });
    c.send(200, t);
  });
  r.route('PATCH', '/teams/:id', async (c) => {
    const t = team(c);
    if (!t) return c.send(404, { error: 'no such preset' });
    saved(c, 200, Object.assign(t, normalizePreset(await c.body(), adapters, t)));
  });
  r.route('DELETE', '/teams/:id', (c) => {
    const t = team(c);
    if (!t) return c.send(404, { error: 'no such preset' });
    store.config.teams = store.config.teams.filter((x) => x !== t);
    saved(c, 200, { ok: true });
  });

  // Phone: ntfy / Telegram settings (secrets masked), and a test message.
  r.route('GET', '/remote', (c) => c.send(200, remote.view()));
  r.route('PUT', '/remote', async (c) => c.send(200, remote.update(await c.body())));
  r.route('POST', '/remote/test', async (c) => {
    const sent = await remote.send({ title: '✨ wisp', text: 'Test from wisp: questions and finished tasks will show up like this.', actions: [] });
    if (!sent) return c.send(400, { error: 'Turn on ntfy or link Telegram first.' });
    c.send(200, remote.view());
  });

  r.route('GET', '/projects', (c) => c.send(200, store.config.projects));
  r.route('POST', '/projects', async (c) => {
    const body = await c.body();
    if (body.machine) {
      const p = await machines.addProject(String(body.machine), String(body.repo || body.path || '').trim(), body.name);
      app.broadcast('config', {});
      return c.send(201, p);
    }
    // A repo URL (in `repo`, or pasted into `path`): clone it, then add the clone.
    const typed = String(body.repo || body.path || '').trim();
    const local = !body.repo && (/^[~./\\]|^[a-z]:/i.test(typed) || fs.existsSync(expand(typed)));
    const repo = !local && parseRepo(typed, { shorthand: true });
    if (body.repo && !repo) return c.send(400, { error: `Not a repo URL: ${typed}` });
    let dir = expand(typed);
    let cloned = null;
    if (repo) {
      const out = await cloneRepo(repo, cloneRoot(store.config));
      dir = out.dir;
      cloned = { url: repo.url, existed: out.existed };
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return c.send(400, { error: `Not a folder: ${dir}` });
    // Its origin: the same repo added on another place joins that project, and a machine
    // without a checkout of it can clone it.
    const origin = await originAt(dir);
    const p = store.addProject(dir, { name: body.name, repo: origin || undefined });
    app.broadcast('config', {});
    c.send(201, { ...p, ...(cloned && { cloned }), ...(origin && { origin }) });
  });
  // Another wisp (this computer is one of its machines) needs a checkout of `repo` here: one that's
  // already here, else a fresh clone. It's added as a project here too.
  r.route(
    'POST',
    '/projects/checkout',
    async (c) => {
      const { repo, name } = await c.body();
      const out = await checkout(store, String(repo || ''));
      const p = store.addProject(out.dir, { name: name ? String(name) : undefined, repo: String(repo) });
      app.broadcast('config', {});
      c.send(200, { path: out.dir, existed: !!out.existed, name: p.name });
    },
    { doc: false },
  );
  r.route('GET', '/projects/origin', async (c) => c.send(200, { origin: await originAt(expand(c.query.get('path') || '.')) }), { doc: false });
  // Find git repos in the usual places so adding projects is one click.
  r.route('GET', '/projects/discover', (c) => c.send(200, discoverRepos(new Set(store.config.projects.map((p) => store.pathAt(p)).filter(Boolean)))), { doc: false });
  // The user's GitHub repos (gh's login), newest first, minus ones already added: one click clones.
  // Empty when gh isn't installed or signed in.
  r.route(
    'GET',
    '/projects/github',
    async (c) => {
      const list = await gh(os.homedir(), ['repo', 'list', '--limit', '40', '--json', 'nameWithOwner,description,isPrivate,isFork,pushedAt,url'], { timeout: 20_000 })
        .then((out) => JSON.parse(out || '[]'))
        .catch(() => null);
      if (!list) return c.send(200, []);
      const origins = await Promise.all(
        store.config.projects.map((p) => p.repo || (store.pathAt(p) ? git(store.pathAt(p), ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => '') : '')),
      );
      const have = new Set(origins.map((o) => parseRepo(o)?.gh?.toLowerCase()).filter(Boolean));
      c.send(
        200,
        list
          .filter((x) => !have.has(x.nameWithOwner.toLowerCase()))
          .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
          .slice(0, 24)
          .map((x) => ({ repo: x.nameWithOwner, url: x.url, description: x.description || '', private: !!x.isPrivate, fork: !!x.isFork, pushedAt: x.pushedAt })),
      );
    },
    { doc: false },
  );
  const project = (c) => store.config.projects.find((x) => x.id === c.params.id);
  r.route('PATCH', '/projects/:id', async (c) => {
    const p = project(c);
    if (!p) return c.send(404, { error: 'no such project' });
    const body = await c.body();
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
    if (typeof body.color === 'string') p.color = body.color;
    // Auto's test check: the command to run, '' to detect it, 'off' for none.
    if (typeof body.testCommand === 'string') body.testCommand.trim() ? (p.testCommand = body.testCommand.trim().slice(0, 500)) : delete p.testCommand;
    app.configChanged();
    c.send(200, p);
  });
  r.route('DELETE', '/projects/:id', (c) => {
    if (!project(c)) return c.send(404, { error: 'no such project' });
    store.config.projects = store.config.projects.filter((x) => x.id !== c.params.id);
    app.configChanged();
    c.send(200, { ok: true });
  });
}
