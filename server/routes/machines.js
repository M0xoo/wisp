// /api/machines: add, connect, and browse folders on other computers.

import { sshHosts, discoverHosts } from '../machines.js';

export function register(r, app) {
  const { store, machines } = app;
  const one = (mid) => machines.view().find((x) => x.id === mid);
  // A machine route: 404s for an unknown id before doing anything.
  const known = (fn) => (c) => (machines.get(c.params.id), fn(c, c.params.id));

  r.route('GET', '/machines', (c) => c.send(200, machines.view()));
  r.route('POST', '/machines', async (c) => {
    const body = await c.body();
    const x = machines.add(body);
    if (body.connect !== false) await machines.connect(x.id);
    c.send(201, one(x.id));
  });
  r.route('GET', '/machines/ssh-hosts', (c) => c.send(200, sshHosts()));
  r.route('GET', '/machines/discover', async (c) => c.send(200, await discoverHosts()));
  r.route('PATCH', '/machines/:id', known(async (c, id) => c.send(200, (await machines.update(id, await c.body()), one(id)))));
  r.route(
    'DELETE',
    '/machines/:id',
    known((c, id) => {
      machines.remove(id);
      app.broadcast('config', {});
      c.send(200, { ok: true });
    }),
  );
  r.route('POST', '/machines/:id/connect', known(async (c, id) => c.send(200, await machines.connect(id))));
  r.route('POST', '/machines/:id/disconnect', known((c, id) => c.send(200, (machines.disconnect(id), one(id)))));
  // Stop wisp over there (its agents too); restart starts this version in its place.
  r.route('POST', '/machines/:id/stop', known(async (c, id) => c.send(200, (await machines.stopRemote(id, { restart: !!(await c.body()).restart }), one(id)))));
  r.route('GET', '/machines/:id/fs', known(async (c, id) => c.send(200, await machines.json(id, 'GET', `/fs?q=${encodeURIComponent(c.query.get('q') || '')}`))));
  r.route(
    'GET',
    '/machines/:id/discover',
    known(async (c, id) => {
      const have = new Set(store.config.projects.map((p) => store.pathAt(p, id)).filter(Boolean));
      c.send(200, (await machines.json(id, 'GET', '/projects/discover')).filter((f) => !have.has(f.path)));
    }),
  );
}
