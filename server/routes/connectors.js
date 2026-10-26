// Connectors: MCP servers every task's agent gets (server/connectors.js). Secrets go in and never
// come back out: the page sees which keys are set, not their values.

import { createConnectorAuth } from '../connector-auth.js';
import { connectorView, foundServers, normalizeConnector, ownNames, probe, REACH, storeSecrets } from '../connectors.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function register(r, app) {
  const { store, secrets, runner } = app;
  const list = () => (store.config.connectors ||= []);
  // Harnesses that keep their own copy of a connector (a server by that name in their config).
  const view = () => {
    const own = ownNames(null);
    return {
      connectors: list().map((c) => ({ ...connectorView(c, secrets), own: REACH.filter((a) => own[a]?.has(c.name)), testing: probing.has(c.id) })),
      found: foundServers(list()).filter((f) => !(store.config.connectorsDismissed || []).includes(f.name)),
      reach: REACH,
    };
  };
  const changed = (c, status = 200) => {
    app.configChanged();
    app.broadcast('connectors', {});
    c.send(status, view());
  };
  const find = (c) => list().find((x) => x.id === c.params.id);
  // Testing runs it once and keeps the outcome on the row: the tool count, or why it failed.
  const probing = new Set();
  const test = async (x) => {
    probing.add(x.id);
    app.broadcast('connectors', {});
    try {
      x.test = await probe(x, store.home, runner.bridge);
    } finally {
      probing.delete(x.id);
    }
    app.configChanged();
    app.broadcast('connectors', {});
    // It works now: a task waiting on its sign-in or keys (wisp_connector_signin) carries on.
    if (x.test?.ok) for (const s of store.all()) if (s.ask?.connector?.id === x.id) runner.answer(s, `Done: ${x.name} works (${x.test.count} tool${x.test.count === 1 ? '' : 's'})`);
    return x.test;
  };

  // Signing in with OAuth: the page opens the URL start() gives, the browser comes back to the
  // callback, and the connector is checked again with its new token.
  const auth = createConnectorAuth({ store, secrets, onSignedIn: (x) => test(x).catch(() => {}) });
  app.connectorAuth = auth;

  r.route('GET', '/connectors', (c) => c.send(200, view()));
  r.route('POST', '/connectors', async (c) => {
    const { connector, sets } = normalizeConnector(await c.body(), list());
    storeSecrets(secrets, connector, sets);
    list().push(connector);
    changed(c, 201);
    test(connector).catch(() => {}); // the row shows Checking… until it answers
  });
  r.route('PATCH', '/connectors/:id', async (c) => {
    const was = find(c);
    if (!was) return c.send(404, { error: 'no such connector' });
    const body = await c.body();
    const { connector, sets } = normalizeConnector(body, list(), was);
    // Anything but the switch makes the last test say nothing about it.
    const edited = Object.keys(body).some((k) => k !== 'enabled');
    if (edited) delete connector.test;
    storeSecrets(secrets, connector, sets);
    Object.assign(was, connector);
    for (const k of Object.keys(was)) if (!(k in connector)) delete was[k];
    changed(c);
    if (edited) test(was).catch(() => {});
  });
  r.route('DELETE', '/connectors/:id', (c) => {
    const was = find(c);
    if (!was) return c.send(404, { error: 'no such connector' });
    store.config.connectors = list().filter((x) => x !== was);
    secrets.drop(`connector:${was.id}`);
    changed(c);
  });
  r.route('POST', '/connectors/:id/test', async (c) => {
    const x = find(c);
    if (!x) return c.send(404, { error: 'no such connector' });
    await test(x);
    c.send(200, view());
  });

  // Import servers found in the harnesses' own configs, by name; their values are read here, so
  // they never pass through the page. dismiss: hide those names from the list until new ones appear.
  r.route('POST', '/connectors/import', async (c) => {
    const body = await c.body();
    const names = Array.isArray(body.names) ? body.names.map(String) : [];
    if (Array.isArray(body.dismiss)) store.config.connectorsDismissed = [...new Set([...(store.config.connectorsDismissed || []), ...body.dismiss.map(String)])];
    const added = [];
    const skipped = [];
    for (const f of foundServers(list(), { values: true }).filter((x) => names.includes(x.name))) {
      try {
        const { connector, sets } = normalizeConnector(f, list());
        storeSecrets(secrets, connector, sets);
        list().push(connector);
        added.push(connector);
      } catch (err) {
        skipped.push({ name: f.name, error: err.message });
      }
    }
    app.configChanged();
    app.broadcast('connectors', {});
    c.send(200, { ...view(), skipped });
    // Test them in the background: the rows fill in their tool counts as each answers.
    for (const x of added) test(x).catch(() => {});
  });

  r.route('POST', '/connectors/:id/signin', async (c) => {
    const x = find(c);
    if (!x) return c.send(404, { error: 'no such connector' });
    const { origin } = await c.body();
    let redirect;
    try {
      redirect = new URL('/api/connectors/oauth/callback', String(origin || '')).href;
    } catch {
      return c.send(400, { error: 'origin: the page’s own address, where the browser comes back to' });
    }
    c.send(200, { url: await auth.start(x, redirect) });
  });
  r.route('DELETE', '/connectors/:id/signin', (c) => {
    const x = find(c);
    if (!x) return c.send(404, { error: 'no such connector' });
    auth.signOut(x);
    delete x.test;
    changed(c);
  });
  // Where the sign-in page sends the browser back: a page that says how it went and closes.
  r.route(
    'GET',
    '/connectors/oauth/callback',
    async (c) => {
      let title;
      let text;
      try {
        const x = await auth.finish(Object.fromEntries(c.query));
        app.broadcast('connectors', {});
        title = `Signed in to ${x.name}`;
        text = 'Back in wisp, its tools are ready for your tasks. You can close this tab.';
      } catch (err) {
        title = 'Couldn’t sign in';
        text = err.message;
      }
      c.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      c.res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · wisp</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:380px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main><script>setTimeout(() => window.close(), 1500)</script>`);
    },
    { doc: false },
  );
  // The proxy (server/mcp-connector.js) asks for a token that works; wisp refreshes it if needed.
  r.route(
    'POST',
    '/internal/connectors/:id/token',
    async (c) => {
      if (c.req.headers['x-wisp-token'] !== app.token) return c.send(403, { error: 'bad token' });
      const x = find(c);
      if (!x) return c.send(404, { error: 'no such connector' });
      const { force } = await c.body();
      c.send(200, { token: await auth.token(x, { force: !!force }) });
    },
    { doc: false },
  );

  // --- The agent's tools (mcp-ask.js): wisp_connectors, wisp_connector_add, wisp_connector_signin ---
  // Only the user's own tasks change connectors: not a subagent, nor a crew member's job. Secret
  // values never pass through the agent: it names the keys, the user fills them in on a card.
  const session = (c) => (c.req.headers['x-wisp-token'] !== app.token ? null : store.get(c.params.sid));
  const tool = (fn, { change = false } = {}) => async (c) => {
    if (c.req.headers['x-wisp-token'] !== app.token) return c.send(403, { error: 'bad token' });
    const s = session(c);
    if (!s) return c.send(404, { error: 'no such session' });
    if (change && (s.parentId || s.crew)) return c.send(200, { error: 'Only a task the user started can change their connectors; a subagent or a crew member’s job can’t. Tell the user what to add instead.' });
    try {
      c.send(200, await fn(s, (c.req.method === 'GET' ? {} : await c.body()) || {}));
    } catch (err) {
      c.send(200, { error: err.message });
    }
  };
  const named = (name) => {
    const want = String(name || '').trim().toLowerCase();
    const x = list().find((y) => y.name === want || y.id === want);
    if (!x) throw new Error(`No connector called “${name}”. List them with wisp_connectors.`);
    return x;
  };
  // Keys it needs that have no value yet.
  const missing = (x) => [...(x.env || []).map((k) => `env:${k}`), ...(x.headers || []).map((k) => `header:${k}`)].filter((k) => secrets.get(`connector:${x.id}`, k) == null);
  const state = (x) => {
    const v = connectorView(x, secrets);
    if (x.enabled === false) return 'off';
    if (missing(x).length) return `needs ${missing(x).map((k) => k.split(':')[1]).join(', ')} from the user (wisp_connector_signin)`;
    if (x.test?.ok) return `works: ${x.test.count} tool${x.test.count === 1 ? '' : 's'}${x.test.tools?.length ? ` (${x.test.tools.slice(0, 8).join(', ')}${x.test.count > 8 ? ', …' : ''})` : ''}`;
    if (x.test?.auth) return 'needs the user to sign in (wisp_connector_signin)';
    if (x.test) return `fails: ${x.test.error}`;
    return v.signedIn ? 'signed in, not checked yet' : 'not checked yet';
  };
  const line = (x) => `- **${x.name}** · ${x.transport === 'local' ? `local: \`${[x.command, ...(x.args || [])].join(' ')}\`` : `remote: ${x.url}`}${x.oauth ? ' · signed in' : ''} · ${state(x)}`;
  const ready = 'Tasks get it from their next turn: harnesses load MCP servers when a turn starts, so this turn can’t call it yet.';

  r.route('GET', '/internal/connectors/:sid', tool(() => ({ text: list().length ? `The user's connectors (MCP servers every task gets; not in Plan mode, not Cursor or Antigravity):\n\n${list().map(line).join('\n')}` : 'The user has no connectors yet. Add one with wisp_connector_add.' })), { doc: false });
  r.route(
    'POST',
    '/internal/connectors/:sid',
    tool(
      async (s, body) => {
        // Names only: a value here would sit in this task's transcript.
        for (const field of ['env', 'headers']) {
          const v = body[field];
          if (v && !Array.isArray(v)) throw new Error(`${field}: give the names only, like ["API_KEY"]. The user types the values on the card wisp_connector_signin shows, so they never pass through you.`);
        }
        const { connector } = normalizeConnector({ ...body, env: (body.env || []).map((key) => ({ key })), headers: (body.headers || []).map((key) => ({ key })) }, list());
        list().push(connector);
        app.configChanged();
        app.broadcast('connectors', {});
        app.telemetry?.track('connector_tool', { agent: s.agent, op: 'add', transport: connector.transport });
        // With keys still to fill in, a check would only fail.
        if (!missing(connector).length) await test(connector).catch(() => {});
        return { text: `Added ${connector.name} to the user's connectors (Settings → Connectors).\n\n${line(connector)}\n\n${/needs/.test(state(connector)) ? 'Next: call wisp_connector_signin so the user can sign in or give the keys.' : ready}` };
      },
      { change: true },
    ),
    { doc: false },
  );
  // A card in the task: Sign in (OAuth) or a box per key. The call waits on it like ask_user, and
  // is answered on its own once the connector works.
  r.route(
    'POST',
    '/internal/connectors/:sid/signin',
    tool(
      async (s, body) => {
        const x = named(body.name);
        const keys = missing(x);
        if (!keys.length && x.test?.ok) return { text: `${x.name} already works: ${state(x)}. ${ready}` };
        if (!keys.length && x.transport === 'local') return { text: `${x.name} has no keys to ask for, and ${state(x)}. Check its command with the user.` };
        const kind = keys.length ? 'keys' : 'signin';
        const names = keys.map((k) => k.split(':')[1]);
        const id = runner.ask(s, {
          question: kind === 'signin' ? `Sign in to ${x.name}` : `${x.name} needs ${names.join(' and ')}`,
          context: String(body.why || '').slice(0, 400),
          options: ['Skip'],
          connector: { id: x.id, name: x.name, kind, keys: [...(x.env || []).map((key) => ({ key, field: 'env' })), ...(x.headers || []).map((key) => ({ key, field: 'headers' }))].map((k) => ({ ...k, set: !keys.includes(`${k.field === 'env' ? 'env' : 'header'}:${k.key}`) })) },
        });
        return { id };
      },
      { change: true },
    ),
    { doc: false },
  );
}
