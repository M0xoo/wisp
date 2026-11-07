// HTTP API + SSE + static web UI. No dependencies.
//
// This file wires the pieces together; the logic lives next to it:
//   http/      the route table, responses, static files
//   routes/    one file per area of the API (sessions, ship, settings, machines, …)
//   services/  what several routes and background jobs share (launching, Ship it, Auto, …)

import { maskOn, maskStep } from './env-mask.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Runner, summarize } from './runner.js';
import { adapters, listAgents } from './adapters/index.js';
import { welcomeSession } from './welcome.js';
import { Telemetry } from './telemetry.js';
import { Updater } from './update.js';
import { Preferences, Retro } from './preferences.js';
import { Terms } from './pty.js';
import { Runs } from './runs.js';
import { Spells, overlayDefaults } from './spells.js';
import { createSpellData } from './spells-data.js';
import { setSpellBlocks } from './render.js';
import { createSpellHooks } from './services/spell-hooks.js';
import { Triggers } from './triggers.js';
import { Crew } from './crew.js';
import { LIMIT_CARRY_ON, Later } from './later.js';
import { syncSpellCrew } from './crew-share.js';
import { ensureWorktree, removeWorktree } from './git.js';
import { Remote } from './remote.js';
import { Machines, splitId } from './machines.js';
import { Secrets } from './secrets.js';
import { turnServers } from './connectors.js';
import { createCloud } from './services/cloud.js';
import { createComputer } from './services/computer.js';
import { createSandbox } from './services/sandbox.js';
import { createApiKeys } from './services/api-keys.js';
import { createAgentLogin } from './agent-login.js';
import { Router } from './router.js';
import { Accounts, useAccounts } from './accounts.js';
import { useConfig as useLean } from './lean.js';
import { Budget, addShare, holdWhy, stopFor, drainWhy } from './budget.js';
import { createLiveLimits, readCodex } from './live-limits.js';
import { Guard } from './guard.js';
import { HarnessWatch } from './harness-watch.js';
import { ProjectTrust } from './project-trust.js';
import { DEFAULT_PORT, VERSION } from './util.js';
import { Routes } from './http/router.js';
import { send, eventStream } from './http/respond.js';
import { isShare, shareNoWorker } from './http/share.js';
import { serveStatic, warmStatic } from './http/static.js';
import { trustedProxy } from './http/trust.js';
import { previewPort, previewRequest, previewUpgrade } from './http/preview.js';
import { createAuto } from './services/auto.js';
import { createBringIn } from './services/bring-in.js';
import { Goals } from './goal.js';
import { scoutNote } from './scout.js';
import { createFeedback } from './services/feedback.js';
import { createInstaller } from './services/install.js';
import { createLaunch } from './services/launch.js';
import { createRelay } from './services/relay.js';
import { createMove } from './services/move.js';
import { createFork } from './services/fork.js';
import { createPlaces } from './services/places.js';
import { phoneActions } from './services/phone.js';
import { createShip } from './services/ship.js';
import { createReview } from './services/review.js';
import { createOverlaps } from './services/overlaps.js';
import { createWorktrees } from './services/worktrees.js';
import { trackTurns } from './services/telemetry.js';
import { Uploads } from './services/uploads.js';
import { Stuff } from './services/stuff.js';
import { Apps } from './services/apps.js';
import { createPublish } from './services/publish.js';
import { createShare } from './services/share.js';
import { notifyWebhooks } from './services/webhooks.js';
import { API_VERSION } from './routes/meta.js';
import * as metaRoutes from './routes/meta.js';
import * as autoRoutes from './routes/auto.js';
import * as internalRoutes from './routes/internal.js';
import * as controlRoutes from './routes/control.js';
import * as uploadRoutes from './routes/uploads.js';
import * as stuffRoutes from './routes/stuff.js';
import * as settingsRoutes from './routes/settings.js';
import * as automationRoutes from './routes/automations.js';
import * as hookRoutes from './routes/hooks.js';
import * as channelRoutes from './routes/channels.js';
import { HOOK_PATH } from './hooks.js';
import * as machineRoutes from './routes/machines.js';
import * as cloudRoutes from './routes/cloud.js';
import * as proxyRoutes from './routes/proxy.js';
import * as sessionRoutes from './routes/sessions.js';
import * as shipRoutes from './routes/ship.js';
import * as workspaceRoutes from './routes/workspace.js';
import * as worktreeRoutes from './routes/worktrees.js';
import * as lspRoutes from './routes/lsp.js';
import { stopAll as stopLanguageServers } from './lsp.js';
import * as spellRoutes from './routes/spells.js';
import * as crewRoutes from './routes/crew.js';
import * as connectorRoutes from './routes/connectors.js';
import * as issueRoutes from './routes/issues.js';

export { API_VERSION };

// Order matters only where patterns overlap: the machine proxy claims <id>@<machine> first.
const ROUTES = [hookRoutes, channelRoutes, metaRoutes, autoRoutes, internalRoutes, controlRoutes, uploadRoutes, stuffRoutes, settingsRoutes, worktreeRoutes, automationRoutes, machineRoutes, cloudRoutes, proxyRoutes, sessionRoutes, shipRoutes, workspaceRoutes, lspRoutes, spellRoutes, crewRoutes, connectorRoutes, issueRoutes];

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
  useLean(() => store.config);
  runner.accounts = accounts;
  runner.accountPref = (agent) => store.config.defaults.accounts?.[agent] || '';
  // Your MCP servers (Settings → Connectors), for every turn of a harness that takes them.
  runner.connectors = ({ agent, mode, cwd }) => turnServers(store.config.connectors, { agent, mode, cwd, home: store.home, bridge: runner.bridge });
  // How much of each account's usage windows is gone (server/budget.js): Settings → Usage and the
  // limit card's reset time. The page hears of a change with the harness list, at most every 2 s.
  let budgetTimer = null;
  let drainSent = null; // agent@account:window → when the phone last heard of it
  const budget = new Budget(store.home, {
    onChange: () => {
      budgetTimer ||= setTimeout(() => {
        budgetTimer = null;
        app.broadcast('agents', {});
      }, 2000);
      budgetTimer.unref?.();
    },
    // Drain watch (Settings → Usage, off by default): the phone hears of it once per two hours per
    // window, when ntfy or Telegram is set up. The card itself comes with the harness list.
    onDrain: (agent, account, d) => {
      if (store.config.defaults.drainWatch !== 'on' || !app.remote?.on) return;
      const key = `${agent}@${account}:${d.id}`;
      const last = (drainSent ||= new Map()).get(key);
      if (last && Date.now() - last < 2 * 3600_000) return;
      drainSent.set(key, Date.now());
      const name = adapters[agent]?.name || agent;
      const label = accounts.multi(agent) ? accounts.get(agent, account)?.label : '';
      app.remote.send({ title: `⚠️ ${name} is using your plan ${d.ratio.toFixed(1)}× faster`, text: drainWhy(d, name, label, agent) }).catch((err) => console.warn(`wisp: phone: ${err.message}`));
    },
    // A window reset before its time (a banked reset): what waits on that plan goes now. After the
    // report that showed it has been handled (it may come in the middle of a run's events).
    onReset: (agent, account, ids) => setImmediate(() => app.resetEarly?.(agent, account, ids)),
    // A turn's part of a window's move: kept on the turn, for its task's details and Where it went.
    onShare: (sid, tid, share) => {
      const s = store.get(sid);
      const turn = s?.turns.find((t) => t.id === tid);
      if (!turn) return;
      addShare(turn, share.agent, share);
      app.sessionChanged(s);
    },
  });
  runner.budget = budget;
  // Ask near the limit (server/guard.js): what a run will likely take of those windows, and whether
  // it should wait for you or the reset.
  const guard = new Guard({ store, budget });
  runner.guard = guard;
  // Harness watch (server/harness-watch.js): says when a harness's program changed since wisp pinned it.
  const harnessWatch = new HarnessWatch(store.home);
  runner.harnessWatch = harnessWatch;
  // Project trust (server/project-trust.js): a repo's hooks, MCP servers and setup wait for your yes.
  const projectTrust = new ProjectTrust(store.home);
  runner.projectTrust = projectTrust;
  const events = eventStream();
  const app = {
    port,
    token,
    store,
    runner,
    events,
    broadcast: events.broadcast,
    uploads: new Uploads(path.join(store.home, 'uploads')),
    // My Stuff: what you and your agents kept (services/stuff.js). Every page repaints its list.
    stuff: new Stuff(path.join(store.home, 'stuff'), { onChange: () => events.broadcast('stuff', {}) }),
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

  // Apps in My Stuff, each on a port of its own while launched (services/apps.js).
  app.apps = new Apps({ stuff: app.stuff, onChange: () => events.broadcast('stuff', {}) });
  stuffRoutes.followStarters(app.stuff);
  app.publish = createPublish(app); // an app's public link on your wisp Grid (services/publish.js)
  runner.stuff = app.stuff; // @-mentions of My Stuff in prompts (mentions.js)

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
  runner.on('activity', (a) => app.broadcast('activity', maskOn(store.config) ? { ...a, item: maskStep(a.item, a.turnId) } : a)); // .env output masked (env-mask.js)
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
      app.broadcast(event, data, { fromMachine: true });
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
  app.goals = runner.goals = new Goals({
    store,
    runner,
    agents: () => app.auto.here(),
    defaults: () => store.config.defaults,
    projectOf: (s) => store.projectFor(s.cwd),
    track: (e, p) => app.telemetry.track(e, p),
    // Automations stop at: a round past it waits for the reset, as a scheduled follow-up.
    hold: (s) => app.reserve.forTask(s),
    fresh: (s) => app.reserve.freshTask(s),
    schedule: (s, entry) => app.later.add(s, entry),
    crew: (id) => app.crew?.get(id), // a crew member who judges a goal, on their own harness
    broadcast: (event, d) => app.broadcast(event, d.item && maskOn(store.config) ? { ...d, item: maskStep(d.item, d.run) } : d), // .env output masked
  });
  app.installer = createInstaller(app);
  runner.on('started', ({ session }) => {
    if (app.router.route(session.id)) return;
    if (session.route) return app.router.record(session.id, session.route);
    // A run you picked yourself: what you pick is Auto's best clue, and how it went counts half.
    if (session.kind || session.crew || session.origin || session.parentId || session.delegated || session.moved || session.worktree?.foreign || !session.turns?.length) return;
    const first = session.turns[0];
    const seen = app.router.observe({ agent: session.agent, model: session.model || '', effort: session.effort || '', prompt: first.prompt, attachments: (first.attachments || []).length });
    if (seen) app.router.record(session.id, { key: seen.key, type: seen.type, label: session.agent, manual: true, at: Date.now() });
  });
  runner.on('ended', ({ session, turn, interrupted }) => {
    if (!app.router.route(session.id) || interrupted) return;
    // A run that stopped at its account's usage limit isn't the model's fault.
    if (session.turns.indexOf(turn) === 0 && !turn.limit) app.router.signal(session.id, { error: turn.status === 'error' || undefined, costUsd: turn.stats?.costUsd, ms: turn.endedAt - turn.startedAt });
    app.auto.signals(summarize(session, store));
  });
  trackTurns(app);

  app.places = createPlaces(app);
  app.mover = createMove(app);
  app.forker = createFork(app);
  app.sharer = createShare(app); // share a task on your wisp Grid, import someone's (services/share.js)
  app.relay = createRelay(app);
  app.cloud = createCloud(app);
  app.computer = createComputer(app);
  app.sandbox = createSandbox(app); // /sandbox: a task in a fresh box on your grid (services/sandbox.js)
  app.apiKeys = createApiKeys(app); // keys for scripting a cloud wisp, kept on the grid (services/api-keys.js)
  // Signing in to a harness from the page; once in, its models are looked up again.
  const loginStates = new Map();
  app.accounts = accounts;
  app.budget = budget;
  app.guard = guard;
  app.harnessWatch = harnessWatch;
  app.projectTrust = projectTrust;
  app.agentLogin = createAgentLogin({
    accounts,
    onChange: (v) => {
      app.broadcast('agent-login', v);
      if (v.state === 'failed' || v.state === 'cancelled') runner.disarmSignIn(v.agent, v.account);
      const k = `${v.agent}/${v.account || ''}`;
      if (loginStates.get(k) === v.state) return;
      loginStates.set(k, v.state);
      const step = { running: 'started', done: 'done', failed: 'failed', cancelled: 'cancelled' }[v.state];
      if (step) app.telemetry.track('agent_login', { agent: v.agent, step });
    },
    // Only that harness is looked up again: the rest (opencode's model list, …) would take seconds.
    onDone: (id) => app.auto.detect({ fresh: id }).then(() => app.broadcast('agents', {}), () => {}),
    // A failed run's sign-in card asked for this: its request goes again (not into a task you have
    // open in a terminal: two agents on one conversation would trample each other).
    onSignedIn: (id, acc) => runner.signInDone(id, acc, { skip: (s) => app.terms.get(s.id)?.code === null }),
  });
  runner.uploads = app.uploads;
  runner.authStatus = (id, acc) => app.agentLogin.status(id, acc); // a signed-out turn's one question to the CLI
  // What a follow-up needs before it runs (launcher.replyTo), for a rerun that doesn't come through it.
  runner.readyToRun = async (s) => {
    for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
    if (s.sideOf) await app.forker.sideFolder(s);
  };
  app.launcher = createLaunch(app);
  app.bringIn = createBringIn(app);
  app.terms = new Terms({
    onChange: (id) => {
      const s = store.get(id);
      if (s) app.broadcast('summary', summarize(s, store));
    },
  });
  // A shell in the task's folder, in the panel beside it: one per task, apart from a take over's.
  app.shells = new Terms({ track: null });
  // The app run from a task's folder, for the panel's Preview (server/runs.js): one per task.
  app.runs = new Runs();
  app.sendFeedback = createFeedback(app);
  // The crew: long-lived agents with a schedule and memory, whose jobs are tasks (server/crew.js).
  app.crew = new Crew({
    store,
    runner,
    // A job's delegates on other machines get their place's name, as any launch's (relay.placeTeam).
    launch: (body, origin, opts) => app.launcher.launch(body.subagents ? { ...body, subagents: app.relay.placeTeam(body.subagents) } : body, origin, opts),
    threadStarted: (s, thread, m, err) => app.remote?.threadStarted(s, thread, m, err),
    // Members on machines: their jobs run there (as summaries and sessions with qualified ids).
    remote: {
      ok: (mid) => store.config.machines.some((m) => m.id === mid && !m.sandbox), // a sandbox is one task's, never a member's machine
      launch: (body, origin) => app.launcher.launchAny(body, origin),
      // A member in a sandbox: their jobs are in their own sandbox, or each in its own.
      jobs: (m) => (m.sandbox ? app.sandbox.crewMachines(m.id) : [m.machine]).flatMap((mid) => [...(app.machines.cache.get(mid)?.values() || [])].filter((s) => s.crew?.id === m.id).map((s) => app.machines.summary(mid, s))),
      sandbox: (m, o) => app.sandbox.forCrew(m, o),
      sandboxJob: (mid, id) => app.sandbox.crewJob(mid, id),
      sandboxFiled: (id) => app.sandbox.jobFiled(id),
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
    followUp: (s, text, { queue = false, team } = {}) => app.launcher.replyTo(s, text, [], queue, undefined, undefined, team, { auto: true }),
    onChange: () => app.broadcast('config', {}),
    exists: (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
    hold: (m) => (m.agent && m.agent !== 'auto' ? app.reserve.check(m.agent) : null),
  });
  // A quiet check-in is archived as it ends: its worktree goes like any archived task's.
  runner.on('ended', ({ session: s }) => {
    if (s.crew && s.archived) for (const x of [s, ...(s.also || [])]) if (x.worktree) removeWorktree(x.worktree, { branch: true }).catch(() => {});
  });
  app.triggers = new Triggers({
    store,
    launch: async (body, origin, opts) => (await app.launcher.launchAny(body, origin, opts))[0],
    hold: (s) => app.reserve.forTask(s),
    fresh: (s) => app.reserve.freshTask(s),
    // A trigger that sends its work to a crew member: the member's job, or its place in the queue.
    assign: async (crewId, work) => {
      const m = app.crew.get(crewId);
      if (!m) throw new Error('That crew member left your crew.');
      const out = await app.crew.assign(m, work);
      return out.session ? (out.session.turns ? summarize(out.session, store) : out.session) : { queued: out.queued, crew: m.id };
    },
    // Another CI failure on a branch that has a task: queued on it, after the turn it's in.
    followUp: async (s, text) => {
      await app.launcher.replyTo(s, text, [], true, undefined, undefined, undefined, { auto: true });
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
    uploads: app.uploads,
    changed: (s) => app.sessionChanged(s),
    configChanged: () => app.configChanged(),
    hold: (s) => app.reserve.forTask(s),
    fresh: (s) => app.reserve.freshTask(s),
    goalRound: (s, l) => app.goals.carryOn(s, l),
    // A reminder came due: the page notifies, and so does the phone.
    notify: (s) => {
      app.broadcast('reminder', { session: summarize(s, store) });
      app.remote.notify(s, summarize(s, store)).catch((err) => console.warn(`wisp: phone: ${err.message}`));
    },
  });
  app.later.onRemoved = (s) => app.broadcast('removed', { id: s.id });
  // Automations stop at (Settings → Usage): work nobody started by hand (check-ins, triggers, goal
  // rounds, agents' own follow-ups) waits while the account it would run on is past that share of a
  // usage window, and goes on at the reset. null: it can run. See design/budget.md.
  app.reserve = {
    check(agent, account = '') {
      const h = budget.hold(agent, account || runner.accountOf(agent), stopFor(store.config.defaults, agent));
      return h && { ...h, why: holdWhy(h, adapters[agent]?.name || agent, accounts.multi(agent) ? accounts.get(agent, h.account)?.label : '') };
    },
    forTask: (s) => app.reserve.check(s.agent, s.account || 'default'),
    // Just before a gate (held-back work only): one free read when the reading is old. check()
    // stays synchronous: Crew.view calls it on every render and must never read.
    fresh: (agent, account = '') => app.liveLimits?.before(agent, account || runner.accountOf(agent)),
    freshTask: (s) => app.reserve.fresh(s.agent, s.account || 'default'),
  };
  // At a usage limit with Settings → Wait for the reset on: the task carries on in the same
  // conversation once the window resets. null: it asks you (the limit card) as before. limit: which
  // plan it waits on, so an early reset of that one sends it sooner (app.resetEarly).
  runner.waitAtLimit = (s, at) => {
    if (store.config.defaults.limitWait !== 'on') return null;
    try {
      return app.later.add(s, { text: LIMIT_CARRY_ON, by: 'wisp', at: Math.max(at, Date.now() + 61_000), limit: { agent: s.turns.at(-1)?.agent || s.agent, account: s.account || 'default' } });
    } catch {
      return null; // a subagent, five already waiting, ten in a row: the card asks instead
    }
  };
  // A window of agent's account reset early (server/budget.js onReset, from a run's report or from
  // Check Codex while work waits): follow-ups and held runs on that plan come due now, crew members
  // and triggers skipped for it stop saying so, and the phone hears how many started.
  const planFree = (agent, account) => !app.reserve.check(agent, account) && !budget.resetAt(agent, account);
  app.resetEarly = (agent, account) => {
    const n = app.later.pullForward(agent, account, planFree);
    if (!planFree(agent, account)) return n; // another window still holds it (the weekly one, say)
    app.crew?.release(agent);
    app.triggers?.release(agent);
    if (n) app.later.tick().catch((err) => console.warn(`wisp: later: ${err.message}`));
    const name = adapters[agent]?.name || agent;
    const label = accounts.multi(agent) ? ` (${accounts.get(agent, account)?.label || account})` : '';
    if (n && app.remote?.on) app.remote.send({ title: `↻ ${name}${label} reset early`, text: `Its plan reset before its time. ${n} task${n === 1 ? '' : 's'} waiting on it start${n === 1 ? 's' : ''} now.` }).catch((err) => console.warn(`wisp: phone: ${err.message}`));
    return n;
  };
  // Work that waits on an account's plan: a held run, a follow-up moved to the reset or waiting at a
  // limit, a crew member or trigger skipped for it. Check Codex while work waits asks only then.
  const waitingOn = (agent, account) =>
    store.all().some((s) => {
      if (s.archived) return false;
      const t = s.turns?.at(-1);
      if (t?.status === 'held' && t.held?.agent === agent && (t.held.account || 'default') === account) return true;
      const mine = s.agent === agent && (s.account || 'default') === account;
      return !!s.later?.some((l) => (l.held && mine) || (l.limit?.agent === agent && (l.limit.account || 'default') === account));
    }) ||
    ((account === runner.accountOf(agent) || account === 'default') && ((store.config.crew || []).some((m) => m.held?.until > Date.now() && (m.held.agent || m.agent) === agent) || (store.config.triggers || []).some((t) => t.held?.until > Date.now() && t.held.agent === agent)));
  app.liveLimits = createLiveLimits({ store, budget, accounts, waiting: waitingOn, read: (env) => readCodex({ bin: adapters.codex?.binary?.(), env }) });
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
  app.worktrees = createWorktrees(app); // old worktrees: the hourly cleanup, Settings → Worktrees
  app.worktrees.start();
  app.review = createReview(app); // review by another harness before Merge (defaults.review)
  app.ship = createShip(app);
  createSpellHooks(app);

  const routes = new Routes();
  for (const mod of ROUTES) mod.register(routes, app);
  app.routes = routes;

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const proxy = trustedProxy();
  app.publicUrl = proxy.origin;
  app.proxy = proxy;
  const previews = proxy.on && !!process.env.WISP_PREVIEW_URL;

  const server = http.createServer(async (req, res) => {
    // Agents can run with broad permissions, so only same-origin local pages may talk to us, or a
    // trusted proxy that has checked who is asking (server/http/trust.js).
    const viaProxy = proxy.via(req);
    // A page the agent left running here, at its preview address on the grid (http/preview.js).
    // Never this wisp itself at a preview's address: its own port, or previews off, is a 404.
    if (viaProxy && req.headers['x-wisp-preview'] !== undefined) {
      const p = previews && previewPort(req.headers, port);
      return p ? previewRequest(req, res, p) : send(res, 404, { error: 'not found' });
    }
    // A trigger's secret URL (server/hooks.js) is called from outside (Slack, Linear, a tunnel's
    // host): its token stands in for the guard below, and the route checks it and the signature.
    const hook = req.method === 'POST' && HOOK_PATH.test(String(req.url).split('?')[0]);
    if (!hook && !viaProxy && !allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    if (isShare(req)) return shareNoWorker(req, res);
    if (!hook && req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (viaProxy ? !proxy.originOk(req) : origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'forbidden origin' });
      const ct = String(req.headers['content-type'] || '');
      const isUpload = (req.url.startsWith('/api/uploads') || req.url.startsWith('/api/stuff/upload')) && ct.startsWith('application/octet-stream');
      if (!ct.startsWith('application/json') && !isUpload) return send(res, 415, { error: 'json only' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    // Not a channel's message: it must never keep a cloud wisp awake. The work it starts does that.
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname !== channelRoutes.CHANNEL_INBOUND) app.lastActivityAt = Date.now();
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
      if (!res.headersSent) send(res, err.status || 500, { error: err.message, ...(err.hold && { hold: err.hold }), ...(err.sandboxLogin && { sandboxLogin: true }) }); // hold: Ask near the limit (server/guard.js); sandboxLogin: /sandbox needs Settings → Cloud → Sandboxes
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const p = previews && proxy.via(req) && previewPort(req.headers, port);
    if (!p) return socket.destroy();
    previewUpgrade(req, socket, head, p);
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
    app.apps.stopAll();
    stopLanguageServers();
    app.triggers.stop();
    app.crew.stop();
    app.later.stop();
    app.remote.stop();
    app.liveLimits.stop();
    app.machines.stop(); // the tunnels go; wisp over there keeps running, agents and all
    app.ship.stop();
    app.overlaps.stop();
    app.worktrees.stop();
    app.cloud.stop();
    app.computer.stop();
    app.sandbox.stop();
    app.agentLogin.stop();
    app.terms.closeAll();
    app.shells.closeAll();
    app.runs.closeAll();
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
  app.liveLimits.start();
  app.machines.start();
  app.computer.start();
  app.sandbox.start();

  app.auto.detect().catch(() => {});
  // The page's files, ready before the window asks (not under `node --test`: hundreds of servers).
  if (!process.env.NODE_TEST_CONTEXT) setImmediate(warmStatic);
  const { telemetry } = app;
  if (telemetry.enabled) {
    if (store.config.defaults.telemetryNotice !== 'seen') console.log('wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.');
    listAgents()
      .then((agents) => telemetry.track('app_started', { agentsInstalled: agents.filter((a) => a.available).map((a) => a.id), ...Object.fromEntries(agents.filter((a) => a.available).map((a) => [`${a.id}Version`, a.version])) }))
      .catch(() => {});
  }

  return { url: `http://localhost:${port}`, server, store, runner, shutdown, telemetry, triggers: app.triggers, later: app.later, crew: app.crew, guard: app.guard, budget: app.budget, token, stuff: app.stuff, remote: app.remote, liveLimits: app.liveLimits, resetEarly: app.resetEarly, machines: app.machines, computer: app.computer, sandbox: app.sandbox, secrets: app.secrets, accounts: app.accounts, auto: app.auto, broadcast: app.broadcast, routes };
}
