// The server itself: live events, health, self-update, the API description, installed
// harnesses, folder suggestions, usage and feedback.

import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { openapi } from '../openapi.js';
import { pageEvent } from '../telemetry.js';
import { triggerView } from '../triggers.js';
import { toolStats, usage } from '../usage.js';
import { expandHome, VERSION } from '../util.js';

export const API_VERSION = 1;

export function register(r, app) {
  const { store, runner, updater, telemetry, machines, port } = app;

  r.route('GET', '/events', (c) => app.events.attach(c.req, c.res));

  r.route('GET', '/health', (c) => c.send(200, { ok: true, name: 'wisp', version: VERSION, apiVersion: API_VERSION, pid: process.pid, url: app.publicUrl || `http://127.0.0.1:${port}` }));

  // Whether anything is going on, for whoever starts and stops this wisp (wisp Grid stops an idle
  // one): turns running, side questions, open pages, the last change, and the next scheduled task.
  r.route('GET', '/status', (c) => {
    const next = [...(store.config.triggers || []).map((t) => triggerView(t).nextAt), app.crew?.nextWake(), app.later?.nextAt()] // crew check-ins and scheduled follow-ups wake it too
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    c.send(200, { live: runner.live.size, sides: runner.sides.size, terms: app.terms?.active() || 0, clients: [...app.events.clients].filter((x) => !x.relay).length, lastActivityAt: app.lastActivityAt || null, nextWakeAt: next || null, version: VERSION });
  });

  // New wisp-agents on npm? POST installs it and relaunches; running agents are stopped, so the
  // client must pass force once it has confirmed that with the user.
  r.route('GET', '/update', async (c) => {
    if (c.query.has('check')) return c.send(200, await updater.check());
    updater.maybeCheck(); // the UI asks on focus and reconnect: a day-old check gets refreshed
    c.send(200, updater.view());
  });
  r.route('POST', '/update', async (c) => {
    const body = await c.body();
    if (runner.live.size && !body.force) return c.send(409, { error: 'agents are running', running: runner.live.size });
    await updater.install();
    c.send(202, updater.view());
    telemetry.track('update', { from: updater.state.current, to: updater.state.latest, method: updater.method });
    setTimeout(() => (app.shutdown(), process.exit(0)), 300);
  });

  r.route('GET', '/openapi.json', (c) => c.send(200, openapi({ version: VERSION, port })), { doc: false });

  // Each harness that can have several accounts lists them (server/accounts.js), in your order, and
  // one whose CLI reports its usage windows says how much of them is gone (server/budget.js).
  const withAccounts = (list) =>
    list.map((a) => {
      const budget = app.budget?.view(a.id) || [];
      return { ...a, ...(app.accounts?.supports(a.id) && { accounts: app.accounts.view(a.id) }), ...(budget.length && { budget }) };
    });
  // ?fresh=1 detects every harness again; ?fresh=<id> just that one (after signing in to it).
  r.route('GET', '/agents', async (c) => c.send(200, withAccounts(await (c.query.has('fresh') ? app.auto.detect({ fresh: Object.hasOwn(adapters, c.query.get('fresh')) ? c.query.get('fresh') : true }) : app.auto.listed()))));
  // Re-check: detect harnesses and models again, here and on every online machine.
  r.route('POST', '/agents/recheck', async (c) => {
    const [agents] = await Promise.all([app.auto.detect({ fresh: true }), machines.recheckAgents()]);
    c.send(200, withAccounts(agents));
  });
  // Sign in to a harness here: its own login, shown as a link, a code, and a box to paste one back.
  // ?account=<id>: one of its extra accounts (none: the CLI's own).
  const acc = (c) => c.query.get('account') || '';
  r.route('GET', '/agents/:id/login', async (c) => c.send(200, { ...app.agentLogin.view(c.params.id, acc(c)), ...(await app.agentLogin.status(c.params.id, acc(c))) }));
  r.route('POST', '/agents/:id/login', (c) => c.send(200, app.agentLogin.start(c.params.id, acc(c))));
  r.route('POST', '/agents/:id/login/input', async (c) => c.send(200, app.agentLogin.input(c.params.id, (await c.body()).code, acc(c))));
  r.route('DELETE', '/agents/:id/login', (c) => c.send(200, app.agentLogin.cancel(c.params.id, acc(c))));
  r.route('POST', '/agents/:id/logout', async (c) => c.send(200, await app.agentLogin.logout(c.params.id, acc(c))));
  // A harness's accounts: add one (its sign-in starts at once), rename, reorder or set its kind
  // (personal or work), remove.
  r.route('GET', '/agents/:id/accounts', (c) => c.send(200, { accounts: app.accounts.supports(c.params.id) ? app.accounts.view(c.params.id) : [] }));
  r.route('POST', '/agents/:id/accounts', async (c) => {
    const { label, kind } = await c.body();
    const account = app.accounts.add(c.params.id, label, kind || '');
    const login = app.agentLogin.start(c.params.id, account.id);
    app.broadcast('agents', {});
    telemetry.track('account', { agent: c.params.id, step: 'added', count: app.accounts.list(c.params.id).length });
    c.send(200, { account: app.accounts.view(c.params.id).find((a) => a.id === account.id), accounts: app.accounts.view(c.params.id), login });
  });
  r.route('PATCH', '/agents/:id/accounts/:acc', async (c) => {
    const { label, move, kind } = await c.body();
    const accounts = app.accounts.update(c.params.id, c.params.acc, { label, move, kind });
    app.broadcast('agents', {});
    c.send(200, { accounts });
  });
  r.route('DELETE', '/agents/:id/accounts/:acc', async (c) => {
    const { id, acc: a } = c.params;
    if (a === 'default') app.accounts.remove(id, a); // refuses, with the reason
    if (!app.accounts.get(id, a)) return c.send(404, { error: 'No such account.' });
    app.agentLogin.cancel(id, a);
    await app.agentLogin.logout(id, a).catch(() => {}); // its login goes with it (the keychain item too)
    const accounts = app.accounts.remove(id, a);
    app.broadcast('agents', {});
    telemetry.track('account', { agent: id, step: 'removed', count: accounts.length });
    c.send(200, { accounts });
  });
  // Harnesses that sign in with an API key (opencode Zen and Go): which have one, add, remove.
  r.route('GET', '/agents/:id/keys', (c) => c.send(200, app.agentLogin.keys(c.params.id)));
  r.route('POST', '/agents/:id/keys', async (c) => {
    const { provider, key } = await c.body();
    c.send(200, app.agentLogin.setKey(c.params.id, String(provider || ''), key));
  });
  r.route('DELETE', '/agents/:id/keys/:provider', (c) => c.send(200, app.agentLogin.removeKey(c.params.id, c.params.provider)));
  // No harness yet: install one (opencode) without leaving wisp. Answers once it's ready.
  r.route('POST', '/agents/install', async (c) => {
    const { id } = await c.body();
    c.send(200, await app.installer.run(String(id || '')));
  });

  // Directory suggestions for the launcher's project picker.
  r.route(
    'GET',
    '/fs',
    (c) => {
      const raw = expandHome(c.query.get('q') || '');
      const trailing = /[\\/]$/.test(raw); // a trailing backslash counts too (Windows)
      const dir = trailing ? raw : path.dirname(raw);
      const prefix = trailing ? '' : path.basename(raw).toLowerCase();
      let entries = [];
      try {
        entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
          .slice(0, 12)
          .map((e) => path.join(dir, e.name));
      } catch {}
      c.send(200, entries);
    },
    { doc: false },
  );

  // Spend and outcomes. ?days=7|30|90
  r.route('GET', '/usage', (c) => c.send(200, usage(store.all(), { days: Number(c.query.get('days')) || 30, project: (s) => store.projectFor(s.cwd) })));
  // Tool calls by kind, harness, project and day (what wisp_stats tells agents).
  r.route('GET', '/usage/tools', (c) =>
    c.send(200, toolStats(store.all(), { days: Math.min(Math.max(Number(c.query.get('days')) || 30, 1), 365), project: (s) => store.projectFor(s.cwd), filter: { agent: c.query.get('agent') || '', project: c.query.get('project') || '' } })),
  );

  // Feedback for the wisp team: thumbs on a turn and/or a note. { rating?, text?, sessionId?, turnId? }
  r.route('POST', '/feedback', async (c) => c.send(200, await app.sendFeedback(await c.body())));

  // A click on the page worth counting (PAGE_EVENTS in telemetry.js). Unknown events are ignored.
  r.route('POST', '/telemetry/event', async (c) => {
    const { event, props } = await c.body();
    const p = pageEvent(event, props || {});
    if (p) telemetry.track(event, p);
    c.send(200, { ok: true, tracked: !!p && telemetry.enabled });
  });
}
