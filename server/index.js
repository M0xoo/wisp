// HTTP API + SSE + static web UI. No dependencies.
//
// This file wires the pieces together; the logic lives next to it:
//   http/      the route table, responses, static files
//   routes/    one file per area of the API (sessions, ship, settings, machines, …)
//   services/  what several routes and background jobs share (launching, Ship it, Auto, …)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Runner, summarize } from './runner.js';
import { listAgents } from './adapters/index.js';
import { welcomeSession } from './welcome.js';
import { Telemetry } from './telemetry.js';
import { Updater } from './update.js';
import { Preferences, Retro } from './preferences.js';
import { Terms } from './pty.js';
import { Spells, overlayDefaults } from './spells.js';
import { createSpellData } from './spells-data.js';
import { setSpellBlocks } from './render.js';
import { createSpellHooks } from './services/spell-hooks.js';
import { Triggers } from './triggers.js';
import { Crew } from './crew.js';
import { LIMIT_CARRY_ON, Later } from './later.js';
import { syncSpellCrew } from './crew-share.js';
import { removeWorktree } from './git.js';
import { Remote } from './remote.js';
import { Machines, splitId } from './machines.js';
import { Secrets } from './secrets.js';
import { turnServers } from './connectors.js';
import { createCloud } from './services/cloud.js';
import { createComputer } from './services/computer.js';
import { createAgentLogin } from './agent-login.js';
import { Router } from './router.js';
import { Accounts, useAccounts } from './accounts.js';
import { Budget } from './budget.js';
import { DEFAULT_PORT, VERSION } from './util.js';
import { Routes } from './http/router.js';
import { send, eventStream } from './http/respond.js';
import { serveStatic } from './http/static.js';
import { trustedProxy } from './http/trust.js';
import { createAuto } from './services/auto.js';
import { Goals } from './goal.js';
import { scoutNote } from './scout.js';
import { createFeedback } from './services/feedback.js';
import { createInstaller } from './services/install.js';
import { createLaunch } from './services/launch.js';
import { createRelay } from './services/relay.js';
import { createMove } from './services/move.js';
import { createPlaces } from './services/places.js';
import { phoneActions } from './services/phone.js';
import { createShip } from './services/ship.js';
import { createOverlaps } from './services/overlaps.js';
import { trackTurns } from './services/telemetry.js';
import { Uploads } from './services/uploads.js';
import { notifyWebhooks } from './services/webhooks.js';
import { API_VERSION } from './routes/meta.js';
import * as metaRoutes from './routes/meta.js';
import * as autoRoutes from './routes/auto.js';
import * as internalRoutes from './routes/internal.js';
import * as uploadRoutes from './routes/uploads.js';
import * as settingsRoutes from './routes/settings.js';
import * as automationRoutes from './routes/automations.js';
import * as machineRoutes from './routes/machines.js';
import * as cloudRoutes from './routes/cloud.js';
import * as proxyRoutes from './routes/proxy.js';
import * as sessionRoutes from './routes/sessions.js';
import * as shipRoutes from './routes/ship.js';
import * as spellRoutes from './routes/spells.js';
import * as crewRoutes from './routes/crew.js';
import * as connectorRoutes from './routes/connectors.js';

export { API_VERSION };

// Order matters only where patterns overlap: the machine proxy claims <id>@<machine> first.
const ROUTES = [metaRoutes, autoRoutes, internalRoutes, uploadRoutes, settingsRoutes, automationRoutes, machineRoutes, cloudRoutes, proxyRoutes, sessionRoutes, shipRoutes, spellRoutes, crewRoutes, connectorRoutes];

// Idle keep-alive connections are closed by the client first (Node's fetch: 4s, browsers: longer
// but they retry). With Node's 5s default the two raced, and a request sent on a socket the
// server was closing failed with ECONNRESET.
const KEEP_ALIVE_MS = 65_000;

// `app` is what every route and service shares. Services reach each other through it at call
// time, so the order they are created in only matters for what runs right away.
export async function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', handleSignals = true } = {}) {
  const store = new Store();
  const token = randomBytes(16).toString('hex');
  const runner = new Runner(store, { url: `http://127.0.0.1:${port}`, token });
  // Several accounts per harness (server/accounts.js): runs, sign-ins and wisp's own small runs.
  const accounts = new Accounts(store.home);
  useAccounts(accounts);
  runner.accounts = accounts;
  runner.accountPref = (agent) => store.config.defaults.accounts?.[agent] || '';
  // Your MCP servers (Settings → Connectors), for every turn of a harness that takes them.
  runner.connectors = ({ agent, mode, cwd }) => turnServers(store.config.connectors, { agent, mode, cwd, home: store.home, bridge: runner.bridge });
  // How much of each account's usage windows is gone (server/budget.js): Settings → Usage and the
  // limit card's reset time. The page hears of a change with the harness list, at most every 2 s.
  let budgetTimer = null;
  const budget = new Budget(store.home, {
    onChange: () => {
      budgetTimer ||= setTimeout(() => {
        budgetTimer = null;
        app.broadcast('agents', {});
      }, 2000);
      budgetTimer.unref?.();
    },
  });
  runner.budget = budget;
  const events = eventStream();
  const app = {
    port,
    token,
    store,
    runner,
    events,
    broadcast: events.broadcast,
    uploads: new Uploads(path.join(store.home, 'uploads')),
    // After any change to the config: persist it, and tell the open pages to reload it.
    configChanged() {
      store.saveConfig();
      events.broadcast('config', {});
    },
    // After a change to a session's own fields: persist it and send its new summary.
    sessionChanged(s, opts) {
      app.overlaps?.changed(s);
      store.save(s, opts);
      events.broadcast('summary', summarize(s, store));
    },
  };

  if (store.all().length === 0) store.put(welcomeSession());

  // Spells: changes layered over wisp at runtime (server/spells.js). Settings a spell sets win
  // while it's on; config.json keeps only yours.
  app.spells = new Spells(store.home);
  store.config.defaults = overlayDefaults(store.config.defaults, () => app.spells.settings());
  app.spells.onChange = () => app.configChanged();
  app.spellData = createSpellData(app);
  setSpellBlocks((type) => app.spells.enabled().flatMap((x) => x.blocks || []).find((b) => b.type === type) || null);

  // When something last happened here: GET /api/status reports it, so a host can stop an idle wisp.
  app.lastActivityAt = Date.now();
  for (const e of ['started', 'turn', 'ended']) runner.on(e, () => (app.lastActivityAt = Date.now()));
  runner.on('summary', (s) => app.broadcast('summary', s));
  runner.on('activity', (a) => app.broadcast('activity', a));
  runner.on('turn', (t) => app.broadcast('turn', t));
  runner.on('finished', (f) => app.broadcast('finished', f));
  runner.on('finished', ({ session }) => notifyWebhooks(store, session));
  runner.on('finished', ({ session }) => app.remote.notify(store.get(session.id), session).catch((err) => console.warn(`wisp: phone: ${err.message}`)));

  // Machines: other computers running their own wisp, reached over SSH. Their sessions show up
  // here as <id>@<machine>; their events are relayed into this stream.
  app.secrets = new Secrets(store.home);
  app.machines = new Machines({
    store,
    secrets: app.secrets,
    version: VERSION,
    apiVersion: API_VERSION,
    onChange: () => app.broadcast('machines', app.machines.view()),
    onEvent: (event, data) => {
      app.broadcast(event, data);
      if ((event === 'finished' || event === 'summary') && data?.session) app.auto.signals(data.session);
      else if (event === 'summary' && data?.id) app.auto.signals(data);
      if (event === 'summary' && data?.relays) app.relay.notice(data); // a lead there delegating to another place
      const job = event === 'finished' ? data?.session : event === 'summary' ? data : null;
      if (job?.crew) app.crew?.remoteSeen(job); // a crew member's job there ended: file what it learned
      if (event === 'finished' && app.remote.on) notifyFromMachine(data.session).catch((err) => console.warn(`wisp: phone: ${err.message}`));
    },
  });
  async function notifyFromMachine(summary) {
    const at = splitId(summary.id);
    const s = app.machines.session(at.machine, await app.machines.json(at.machine, 'GET', `/sessions/${at.id}`));
    await app.remote.notify(s, summary);
  }
  setInterval(() => app.broadcast('ping', {}), 25_000).unref();

  app.telemetry = new Telemetry(store);
  app.updater = new Updater({ port, channel: () => store.config.defaults.updateChannel, onChange: (u) => app.broadcast('update', u) });

  // Learned preferences: injected into every turn, refreshed by a background retro per session.
  app.prefs = new Preferences(store.home);
  app.learning = () => store.config.defaults.learn !== 'off';
  const projectOf = (cwd) => store.projectFor(cwd)?.path || cwd;
  runner.promptExtra = (s) => (app.learning() && s.agent !== 'wisp' ? app.prefs.prompt(projectOf(s.cwd)) : '') + (s.parentId ? '' : app.spells.promptFor(s, store.projectFor(s.cwd))) + scoutNote(s.scout);
  runner.spellBlocks = (s) => app.spells.blocksFor(s, store.projectFor(s.cwd));
  app.retro = new Retro({
    store,
    runner,
    prefs: app.prefs,
    projectOf,
    enabled: app.learning,
    onStart: () => app.broadcast('preferences', {}),
    onDone: ({ session, ok, added = [], removed = [] }) => {
      app.telemetry.track('retro', { agent: session.agent, ok, added: added.length, removed: removed.length });
      app.broadcast('preferences', { added: added.length, removed: removed.length });
    },
  });

  // Auto: the router, and what feeds it outcomes.
  app.router = new Router(store.home);
  app.auto = createAuto(app);
  // Goals: the task keeps going until its condition holds (server/goal.js).
  app.goals = runner.goals = new Goals({ store, runner, agents: () => app.auto.here(), defaults: () => store.config.defaults, projectOf: (s) => store.projectFor(s.cwd), track: (e, p) => app.telemetry.track(e, p) });
  app.installer = createInstaller(app);
  runner.on('started', ({ session }) => {
    if (session.route && !app.router.route(session.id)) app.router.record(session.id, session.route);
  });
  runner.on('ended', ({ session, turn, interrupted }) => {
    if (!session.route || interrupted) return;
    // A run that stopped at its account's usage limit isn't the model's fault.
    if (session.turns.indexOf(turn) === 0 && !turn.limit) app.router.signal(session.id, { error: turn.status === 'error' || undefined, costUsd: turn.stats?.costUsd, ms: turn.endedAt - turn.startedAt });
    app.auto.signals(summarize(session, store));
  });
  trackTurns(app);

  app.places = createPlaces(app);
  app.mover = createMove(app);
  app.relay = createRelay(app);
  app.cloud = createCloud(app);
  app.computer = createComputer(app);
  // Signing in to a harness from the page; once in, its models are looked up again.
  const loginStates = new Map();
  app.accounts = accounts;
  app.budget = budget;
  app.agentLogin = createAgentLogin({
    accounts,
    onChange: (v) => {
      app.broadcast('agent-login', v);
      const k = `${v.agent}/${v.account || ''}`;
      if (loginStates.get(k) === v.state) return;
      loginStates.set(k, v.state);
      const step = { running: 'started', done: 'done', failed: 'failed', cancelled: 'cancelled' }[v.state];
      if (step) app.telemetry.track('agent_login', { agent: v.agent, step });
    },
    // Only that harness is looked up again: the rest (opencode's model list, …) would take seconds.
    onDone: (id) => app.auto.detect({ fresh: id }).then(() => app.broadcast('agents', {}), () => {}),
  });
  app.launcher = createLaunch(app);
  app.terms = new Terms({
    onChange: (id) => {
      const s = store.get(id);
      if (s) app.broadcast('summary', summarize(s, store));
    },
  });
  app.sendFeedback = createFeedback(app);
  // The crew: long-lived agents with a schedule and memory, whose jobs are tasks (server/crew.js).
  app.crew = new Crew({
    store,
    runner,
    launch: (body, origin, opts) => app.launcher.launch(body, origin, opts),
    // Members on machines: their jobs run there (as summaries and sessions with qualified ids).
    remote: {
      ok: (mid) => store.config.machines.some((m) => m.id === mid),
      launch: (body, origin) => app.launcher.launchAny(body, origin),
      jobs: (m) => [...(app.machines.cache.get(m.machine)?.values() || [])].filter((s) => s.crew?.id === m.id).map((s) => app.machines.summary(m.machine, s)),
      fetch: async (id) => {
        const { id: rid, machine } = splitId(id) || {};
        return app.machines.session(machine, await app.machines.json(machine, 'GET', `/sessions/${rid}`));
      },
      reply: (id, text) => {
        const { id: rid, machine } = splitId(id) || {};
        return app.machines.json(machine, 'POST', `/sessions/${rid}/reply`, { text, queue: true });
      },
    },
    // A member's follow-up on a task it's part of, or yours on its job: sent like any follow-up.
    // team: the task's delegates with the member added, so its agent can hand the work back.
    followUp: (s, text, { queue = false, team } = {}) => app.launcher.replyTo(s, text, [], queue, undefined, undefined, team),
    onChange: () => app.broadcast('config', {}),
    exists: (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
  });
  // A quiet check-in is archived as it ends: its worktree goes like any archived task's.
  runner.on('ended', ({ session: s }) => {
    if (s.crew && s.archived) for (const x of [s, ...(s.also || [])]) if (x.worktree) removeWorktree(x.worktree, { branch: true }).catch(() => {});
  });
  app.triggers = new Triggers({
    store,
    launch: async (body, origin) => (await app.launcher.launchAny(body, origin))[0],
    // A trigger that sends its work to a crew member: the member's job, or its place in the queue.
    assign: async (crewId, work) => {
      const m = app.crew.get(crewId);
      if (!m) throw new Error('That crew member left your crew.');
      const out = await app.crew.assign(m, work);
      return out.session ? (out.session.turns ? summarize(out.session, store) : out.session) : { queued: out.queued, crew: m.id };
    },
    // Another CI failure on a branch that has a task: queued on it, after the turn it's in.
    followUp: async (s, text) => {
      await app.launcher.replyTo(s, text, [], true);
      app.sessionChanged(s);
      return summarize(s, store);
    },
    onChange: () => app.broadcast('config', {}),
  });
  // Later: follow-ups, reminders and tasks at a time you or an agent set (server/later.js).
  app.later = new Later({
    store,
    runner,
    launch: (body, origin) => app.launcher.launchAny(body, origin),
    changed: (s) => app.sessionChanged(s),
    configChanged: () => app.configChanged(),
    // A reminder came due: the page notifies, and so does the phone.
    notify: (s) => {
      app.broadcast('reminder', { session: summarize(s, store) });
      app.remote.notify(s, summarize(s, store)).catch((err) => console.warn(`wisp: phone: ${err.message}`));
    },
  });
  app.later.onRemoved = (s) => app.broadcast('removed', { id: s.id });
  // At a usage limit with Settings → Wait for the reset on: the task carries on in the same
  // conversation once the window resets. null: it asks you (the limit card) as before.
  runner.waitAtLimit = (s, at) => {
    if (store.config.defaults.limitWait !== 'on') return null;
    try {
      return app.later.add(s, { text: LIMIT_CARRY_ON, by: 'wisp', at: Math.max(at, Date.now() + 61_000) });
    } catch {
      return null; // a subagent, five already waiting, ten in a row: the card asks instead
    }
  };
  // A spell's crew members join and leave the crew with it (server/crew-share.js).
  app.spells.onChange = () => {
    syncSpellCrew(app);
    app.configChanged();
  };
  syncSpellCrew(app);
  // Triggers (and crew members) that watch for a task finishing. After the turn's own handlers.
  runner.on('finished', ({ session }) => setImmediate(() => app.triggers.taskEvent('finished', store.get(session.id))));
  // Phone: answers and follow-ups coming back from ntfy / Telegram.
  app.remote = new Remote({ store, onChange: () => app.broadcast('remote', {}), ...phoneActions(app) });
  app.overlaps = createOverlaps(app);
  app.ship = createShip(app);
  createSpellHooks(app);

  const routes = new Routes();
  for (const mod of ROUTES) mod.register(routes, app);
  app.routes = routes;

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const proxy = trustedProxy();
  app.publicUrl = proxy.origin;
  app.proxy = proxy;

  const server = http.createServer(async (req, res) => {
    // Agents can run with broad permissions, so only same-origin local pages may talk to us, or a
    // trusted proxy that has checked who is asking (server/http/trust.js).
    const viaProxy = proxy.via(req);
    if (!viaProxy && !allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (viaProxy ? !proxy.originOk(req) : origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'forbidden origin' });
      const ct = String(req.headers['content-type'] || '');
      const isUpload = req.url.startsWith('/api/uploads') && ct.startsWith('application/octet-stream');
      if (!ct.startsWith('application/json') && !isUpload) return send(res, 415, { error: 'json only' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') app.lastActivityAt = Date.now();
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      if (!(await routes.handle(req, res, url))) send(res, 404, { error: 'not found' });
    } catch (err) {
      // A refusal (bad input, not found, conflict) is an answer, not a server error.
      const expected = err.status && err.status < 500;
      if (!expected) {
        console.error(err);
        app.telemetry.captureError(err, { route: `${req.method} ${url.pathname.replace(/\/[a-f0-9]{8,}(?=\/|$)/g, '/:id')}` });
      }
      if (res.gzipping) return; // the answer is already on its way
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      else res.end();
    }
  });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 1000;

  // Advertise this server so integrations (CLI, MCP, editors) can find it without knowing the port.
  const serverFile = path.join(store.home, 'server.json');
  const shutdown = () => {
    try {
      if (JSON.parse(fs.readFileSync(serverFile, 'utf8')).pid === process.pid) fs.rmSync(serverFile, { force: true });
    } catch {}
    app.retro.stop();
    app.triggers.stop();
    app.crew.stop();
    app.later.stop();
    app.remote.stop();
    app.machines.stop(); // the tunnels go; wisp over there keeps running, agents and all
    app.ship.stop();
    app.overlaps.stop();
    app.cloud.stop();
    app.computer.stop();
    app.agentLogin.stop();
    app.terms.closeAll();
    for (const s of store.all()) runner.stop(s);
    store.flush();
    app.telemetry.persist();
  };
  app.shutdown = shutdown;
  if (handleSignals) {
    const exit = () => (shutdown(), process.exit(0));
    process.once('SIGINT', exit);
    process.once('SIGTERM', exit);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  fs.writeFileSync(serverFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid, version: VERSION, apiVersion: API_VERSION, startedAt: Date.now() }, null, 2));
  app.updater.start();
  app.triggers.start();
  app.crew.start();
  app.later.start();
  app.remote.start();
  app.machines.start();
  app.computer.start();

  app.auto.detect().catch(() => {});
  const { telemetry } = app;
  if (telemetry.enabled) {
    if (store.config.defaults.telemetryNotice !== 'seen') console.log('wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.');
    listAgents()
      .then((agents) => telemetry.track('app_started', { agentsInstalled: agents.filter((a) => a.available).map((a) => a.id), ...Object.fromEntries(agents.filter((a) => a.available).map((a) => [`${a.id}Version`, a.version])) }))
      .catch(() => {});
  }

  return { url: `http://localhost:${port}`, server, store, runner, shutdown, telemetry, triggers: app.triggers, later: app.later, token, remote: app.remote, machines: app.machines, computer: app.computer, auto: app.auto, routes };
}
