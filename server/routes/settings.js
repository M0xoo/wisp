// Settings: the config, what wisp learned, subagent presets, the phone, and projects.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { KINDS } from '../preferences.js';
import { normalizePreset } from '../subagents.js';
import { envDisabled, feedbackAvailable } from '../telemetry.js';
import { TERMINALS } from '../terminal.js';
import { normalizeWebhooks } from '../services/webhooks.js';
import { cloneRepo, gh, git, parseRepo } from '../git.js';
import { expand } from '../util.js';

// Where people keep their repos, for one-click "add project".
const REPO_ROOTS = ['code', 'Code', 'dev', 'Developer', 'projects', 'Projects', 'src', 'repos', 'work', 'git', 'GitHub', 'Documents', 'Downloads', 'Desktop'];

// Where a pasted repo URL is cloned: defaults.cloneDir, else the first usual repo folder that
// exists (not Documents/Downloads/Desktop), else ~/code.
export function cloneRoot(config) {
  if (config.defaults?.cloneDir) return expand(config.defaults.cloneDir);
  const dir = REPO_ROOTS.slice(0, -3)
    .map((r) => path.join(os.homedir(), r))
    .find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  return dir || path.join(os.homedir(), 'code');
}

export function register(r, app) {
  const { store, telemetry, prefs, retro, remote, machines } = app;

  r.route('GET', '/config', (c) =>
    c.send(200, { ...store.config, remote: undefined, home: os.homedir(), cwd: process.cwd(), cloneDir: cloneRoot(store.config), terminals: TERMINALS, telemetry: { available: !envDisabled(), enabled: telemetry.enabled }, feedback: feedbackAvailable() }),
  );
  r.route('PATCH', '/config', async (c) => {
    const body = await c.body();
    if (body.defaults) Object.assign(store.config.defaults, body.defaults);
    if (body.webhooks !== undefined) {
      const { hooks, error } = normalizeWebhooks(body.webhooks);
      if (error) return c.send(400, { error });
      store.config.webhooks = hooks;
    }
    app.configChanged();
    c.send(200, { ...store.config, remote: undefined });
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
    const p = store.addProject(dir, { name: body.name });
    app.broadcast('config', {});
    c.send(201, cloned ? { ...p, cloned } : p);
  });
  // Find git repos in the usual places so adding projects is one click.
  r.route('GET', '/projects/discover', (c) => c.send(200, discoverRepos(new Set(store.config.projects.map((p) => p.path)))), { doc: false });
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
        store.config.projects.filter((p) => !p.machine).map((p) => git(p.path, ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => '')),
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

// Git repos up to two levels under the usual folders, newest first, skipping known ones.
function discoverRepos(known) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= 60) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      if (!known.has(dir)) found.push({ path: dir, name: path.basename(dir), mtime: fs.statSync(dir).mtimeMs });
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth - 1);
  };
  for (const r of REPO_ROOTS) walk(path.join(os.homedir(), r), 2);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 24);
}
