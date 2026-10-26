// Connectors: MCP servers every task's agent gets (server/connectors.js). Secrets go in and never
// come back out: the page sees which keys are set, not their values.

import { connectorView, foundServers, normalizeConnector, ownNames, probe, REACH, storeSecrets } from '../connectors.js';

export function register(r, app) {
  const { store, secrets } = app;
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
      x.test = await probe(x, store.home);
    } finally {
      probing.delete(x.id);
    }
    app.configChanged();
    app.broadcast('connectors', {});
    return x.test;
  };

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
}
