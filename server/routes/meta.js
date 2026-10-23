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
    const next = (store.config.triggers || [])
      .map((t) => triggerView(t).nextAt)
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

  // ?fresh=1 detects every harness again; ?fresh=<id> just that one (after signing in to it).
  r.route('GET', '/agents', async (c) => c.send(200, await (c.query.has('fresh') ? app.auto.detect({ fresh: Object.hasOwn(adapters, c.query.get('fresh')) ? c.query.get('fresh') : true }) : app.auto.listed())));
  // Re-check: detect harnesses and models again, here and on every online machine.
  r.route('POST', '/agents/recheck', async (c) => {
    const [agents] = await Promise.all([app.auto.detect({ fresh: true }), machines.recheckAgents()]);
    c.send(200, agents);
  });
  // Sign in to a harness here: its own login, shown as a link, a code, and a box to paste one back.
  r.route('GET', '/agents/:id/login', async (c) => c.send(200, { ...app.agentLogin.view(c.params.id), ...(await app.agentLogin.status(c.params.id)) }));
  r.route('POST', '/agents/:id/login', (c) => c.send(200, app.agentLogin.start(c.params.id)));
  r.route('POST', '/agents/:id/login/input', async (c) => c.send(200, app.agentLogin.input(c.params.id, (await c.body()).code)));
  r.route('DELETE', '/agents/:id/login', (c) => c.send(200, app.agentLogin.cancel(c.params.id)));
  r.route('POST', '/agents/:id/logout', async (c) => c.send(200, await app.agentLogin.logout(c.params.id)));
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
