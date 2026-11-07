// Settings: the config, what wisp learned, subagent presets, the phone, and projects.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { SUBAGENT_MODELS } from '../adapters/claude.js';
import { STOP_AT, STOP_BY, STOP_KEYS } from '../budget.js';
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
import { REVIEW_VALUES } from '../services/review.js';
import { panesProblem } from '../../web/js/pane-bridge.js';
import { LEAN_VALUES } from '../lean.js';
import { SETTINGS } from '../../web/js/spell-schema.js';
import { fromTunnel } from '../grid-tunnel.js';

// On a wisp Grid (its hostd sets WISP_GRID_URL): the grid, and this wisp's own address there, so
// the page offers connecting through the grid instead of SSH. preview: where a page the agent
// left running on this box shows ("https://p{port}--ada.grid.example"; server/http/preview.js).
// A cloud computer has no terminal app: take over is always in the page there.
const terminals = () => (process.env.WISP_GRID_URL ? TERMINALS.filter((t) => t.id === 'wisp') : TERMINALS);
const gridInfo = (app) => (process.env.WISP_GRID_URL && app.publicUrl ? { url: process.env.WISP_GRID_URL.replace(/\/+$/, ''), address: app.publicUrl, ...(process.env.WISP_PREVIEW_URL && { preview: process.env.WISP_PREVIEW_URL }) } : null);

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
    cloudBox: !!app.publicUrl, // a box has no tunnel: Accept tasks from channels means nothing there
    recipes: [...store.config.recipes, ...app.spells.recipes()],
    crew: app.crew ? app.crew.list.map((m) => app.crew.view(m)) : store.config.crew, // with nextAt and what's running
    triggers: store.config.triggers.map(triggerView), // with nextAt, for split home's Coming up
    spells: app.spells.forPage(),
    spellsSafe: app.spells.safe,
  });
  // The RAM/CPU guard's reading (server/load.js), for Settings → Usage → Machine load.
  r.route('GET', '/load', (c) => c.send(200, app.load.reading()));
  r.route('GET', '/config', (c) =>
    c.send(200, { ...view(), home: os.homedir(), cwd: process.cwd(), cloneDir: cloneRoot(store.config), terminals: terminals(), defaultTerminal: defaultTerminal(), takeoverInline: inWisp(store.config.defaults.terminal || defaultTerminal()), grid: gridInfo(app), preview: process.env.WISP_PREVIEW_URL || app.computer?.previewUrl?.() || '', telemetry: { available: !envDisabled(), enabled: telemetry.enabled }, feedback: feedbackAvailable() }),
  );
  r.route('PATCH', '/config', async (c) => {
    const body = await c.body();
    const locked = app.spells.settings().lockedBy;
    const clash = Object.keys(body.defaults || {}).find((k) => locked[k] && body.defaults[k] !== store.config.defaults[k]);
    if (clash) return c.send(409, { error: `${clash} is set by the spell ${locked[clash].name}. Turn it off in Settings → Spells to change it.`, spell: locked[clash] });
    if (body.defaults?.autoStop !== undefined && !STOP_AT.includes(body.defaults.autoStop)) return c.send(400, { error: `autoStop must be one of ${STOP_AT.join(', ')}` });
    for (const k of Object.values(STOP_KEYS)) if (body.defaults?.[k] !== undefined && !STOP_BY.includes(body.defaults[k])) return c.send(400, { error: `${k} must be one of ${STOP_BY.join(', ')}` });
    if (body.defaults?.liveLimits !== undefined && !['on', 'off'].includes(body.defaults.liveLimits)) return c.send(400, { error: 'liveLimits must be on or off' });
    if (body.defaults?.projectAsk !== undefined && !['on', 'off'].includes(body.defaults.projectAsk)) return c.send(400, { error: 'projectAsk must be on or off' });
    if (body.defaults?.maskEnvFiles !== undefined && !['on', 'off'].includes(body.defaults.maskEnvFiles)) return c.send(400, { error: 'maskEnvFiles must be on or off' });
    if (body.defaults?.review !== undefined && !REVIEW_VALUES.includes(body.defaults.review)) return c.send(400, { error: `review must be one of ${REVIEW_VALUES.join(', ')}` });
    if (body.defaults?.leanRuns !== undefined && !LEAN_VALUES.includes(body.defaults.leanRuns)) return c.send(400, { error: `leanRuns must be one of ${LEAN_VALUES.join(', ')}` });
    if (body.defaults?.automationsPausedUntil !== undefined && !(Number.isInteger(body.defaults.automationsPausedUntil) && body.defaults.automationsPausedUntil >= 0)) return c.send(400, { error: 'automationsPausedUntil must be a time in ms, or 0 (POST /automations/pause)' });
    for (const k of ['memoryFloor', 'cpuCeiling', 'maxRuns', 'batteryHold']) if (body.defaults?.[k] !== undefined && !SETTINGS[k].includes(body.defaults[k])) return c.send(400, { error: `${k} must be one of ${SETTINGS[k].join(', ')}` });
    if (body.defaults?.worktreeCleanup !== undefined && !SETTINGS.worktreeCleanup.includes(body.defaults.worktreeCleanup)) return c.send(400, { error: `worktreeCleanup must be one of ${SETTINGS.worktreeCleanup.join(', ')}` });
    if (body.defaults?.worktreeMax !== undefined && !SETTINGS.worktreeMax.includes(body.defaults.worktreeMax)) return c.send(400, { error: `worktreeMax must be one of ${SETTINGS.worktreeMax.join(', ')}` });
    if (body.defaults?.worktreeOnDone !== undefined && !SETTINGS.worktreeOnDone.includes(body.defaults.worktreeOnDone)) return c.send(400, { error: `worktreeOnDone must be one of ${SETTINGS.worktreeOnDone.join(', ')}` });
    if (body.defaults?.harnessAsk !== undefined && !['on', 'off'].includes(body.defaults.harnessAsk)) return c.send(400, { error: 'harnessAsk must be on or off' });
    if (body.defaults?.subagentModel !== undefined && !SUBAGENT_MODELS.includes(body.defaults.subagentModel)) return c.send(400, { error: 'subagentModel must be \'\' (the task’s model), haiku or sonnet' });
    if (body.defaults?.windowNotice !== undefined && !['on', 'off'].includes(body.defaults.windowNotice)) return c.send(400, { error: 'windowNotice must be on or off' });
    if (body.defaults?.spareCard !== undefined && !['on', 'off'].includes(body.defaults.spareCard)) return c.send(400, { error: 'spareCard must be on or off' });
    if (body.defaults?.drainWatch !== undefined && !['on', 'off'].includes(body.defaults.drainWatch)) return c.send(400, { error: 'drainWatch must be on or off' });
    if (body.defaults?.acceptChannels !== undefined && !['on', 'off'].includes(body.defaults.acceptChannels)) return c.send(400, { error: 'acceptChannels must be on or off' });
    // A computer switches this on itself: not from a phone, and not from anything else with a way in
    // through the grid. Off is fine from anywhere: that's what you'd reach for from a phone.
    if (body.defaults?.acceptChannels === 'on' && store.config.defaults.acceptChannels !== 'on' && fromTunnel(c.req)) return c.send(403, { error: 'Turn this on from the computer itself, in Settings there.' });
    if (body.defaults?.webhookTriggers !== undefined && !['on', 'off'].includes(body.defaults.webhookTriggers)) return c.send(400, { error: 'webhookTriggers must be on or off' });
    if (body.defaults?.panes !== undefined && panesProblem(body.defaults.panes)) return c.send(400, { error: panesProblem(body.defaults.panes) });
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
  r.route('GET', '/remote/slack/manifest', async (c) => c.send(200, await remote.channels.slack.manifest()));
  r.route('GET', '/remote/discord/invite', (c) => c.send(200, remote.discordInvite()));
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
  // Worktrees another tool left in this project's repo (services/bring-in.js). Only ever on request,
  // for this one project. GET never touches the network.
  r.route('GET', '/projects/:id/foreign-worktrees', async (c) => {
    const p = project(c);
    if (!p) return c.send(404, { error: 'no such project' });
    const { from, items, detached } = await app.bringIn.offer(p);
    c.send(200, { from, items, detached });
  });
  r.route('POST', '/projects/:id/foreign-worktrees', async (c) => {
    const p = project(c);
    if (!p) return c.send(404, { error: 'no such project' });
    const { paths } = await c.body();
    if (paths !== undefined && !(Array.isArray(paths) && paths.every((x) => typeof x === 'string'))) return c.send(400, { error: 'paths must be a list of folders' });
    c.send(200, await app.bringIn.take(p, paths));
  });
  r.route('POST', '/projects/:id/foreign-worktrees/dismiss', async (c) => {
    const p = project(c);
    if (!p) return c.send(404, { error: 'no such project' });
    const { undo } = await c.body();
    if (undo !== undefined && !(Array.isArray(undo) && undo.every((x) => typeof x === 'string'))) return c.send(400, { error: 'undo must be a list of folders' });
    c.send(200, await (undo ? app.bringIn.undismiss(p, undo) : app.bringIn.dismiss(p)));
  });
}
