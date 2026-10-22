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
import { Remote } from './remote.js';
import { Machines, splitId } from './machines.js';
import { Secrets } from './secrets.js';
import { createCloud } from './services/cloud.js';
import { createAgentLogin } from './agent-login.js';
import { Router } from './router.js';
import { DEFAULT_PORT, VERSION } from './util.js';
import { Routes } from './http/router.js';
import { send, eventStream } from './http/respond.js';
import { serveStatic } from './http/static.js';
import { trustedProxy } from './http/trust.js';
import { createAuto } from './services/auto.js';
import { scoutNote } from './scout.js';
import { createFeedback } from './services/feedback.js';
import { createInstaller } from './services/install.js';
import { createLaunch } from './services/launch.js';
import { createMove } from './services/move.js';
import { createPlaces } from './services/places.js';
import { phoneActions } from './services/phone.js';
import { createShip } from './services/ship.js';
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

export { API_VERSION };

// Order matters only where patterns overlap: the machine proxy claims <id>@<machine> first.
const ROUTES = [metaRoutes, autoRoutes, internalRoutes, uploadRoutes, settingsRoutes, automationRoutes, machineRoutes, cloudRoutes, proxyRoutes, sessionRoutes, shipRoutes, spellRoutes];

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
  app.updater = new Updater({ port, onChange: (u) => app.broadcast('update', u) });

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
  app.installer = createInstaller(app);
  runner.on('started', ({ session }) => {
    if (session.route && !app.router.route(session.id)) app.router.record(session.id, session.route);
  });
  runner.on('ended', ({ session, turn, interrupted }) => {
    if (!session.route || interrupted) return;
    if (session.turns.indexOf(turn) === 0) app.router.signal(session.id, { error: turn.status === 'error' || undefined, costUsd: turn.stats?.costUsd, ms: turn.endedAt - turn.startedAt });
    app.auto.signals(summarize(session, store));
  });
  trackTurns(app);

  app.places = createPlaces(app);
  app.mover = createMove(app);
  app.cloud = createCloud(app);
  // Signing in to a harness from the page; once in, its models are looked up again.
  const loginStates = new Map();
  app.agentLogin = createAgentLogin({
    onChange: (v) => {
      app.broadcast('agent-login', v);
      if (loginStates.get(v.agent) === v.state) return;
      loginStates.set(v.agent, v.state);
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
  app.triggers = new Triggers({ store, launch: async (body, origin) => (await app.launcher.launchAny(body, origin))[0], onChange: () => app.broadcast('config', {}) });
  // Phone: answers and follow-ups coming back from ntfy / Telegram.
  app.remote = new Remote({ store, onChange: () => app.broadcast('remote', {}), ...phoneActions(app) });
  app.ship = createShip(app);
  createSpellHooks(app);

  const routes = new Routes();
  for (const mod of ROUTES) mod.register(routes, app);
  app.routes = routes;

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const proxy = trustedProxy();
  app.publicUrl = proxy.origin;

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
    app.remote.stop();
    app.machines.stop(); // the tunnels go; wisp over there keeps running, agents and all
    app.ship.stop();
    app.cloud.stop();
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
  app.remote.start();
  app.machines.start();

  app.auto.detect().catch(() => {});
  const { telemetry } = app;
  if (telemetry.enabled) {
    if (store.config.defaults.telemetryNotice !== 'seen') console.log('wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.');
    listAgents()
      .then((agents) => telemetry.track('app_started', { agentsInstalled: agents.filter((a) => a.available).map((a) => a.id), ...Object.fromEntries(agents.filter((a) => a.available).map((a) => [`${a.id}Version`, a.version])) }))
      .catch(() => {});
  }

  return { url: `http://localhost:${port}`, server, store, runner, shutdown, telemetry, triggers: app.triggers, remote: app.remote, machines: app.machines, auto: app.auto, routes };
}
