// /api/machines: add, connect, and browse folders on other computers.

import { sshHosts, discoverHosts } from '../machines.js';
import { reachable } from '../machines/reachable.js';

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
  // Whether other devices (another computer, the phone app) can reach this one over SSH.
  r.route('GET', '/machines/reachable', async (c) => c.send(200, await reachable()));
  r.route('PATCH', '/machines/:id', known(async (c, id) => c.send(200, (await machines.update(id, await c.body()), one(id)))));
  r.route(
    'DELETE',
    '/machines/:id',
    known(async (c, id) => {
      await app.computer.removing(machines.get(id));
      machines.remove(id);
      app.broadcast('config', {});
      c.send(200, { ok: true });
    }),
  );
  // "Let me in": the password once, to put this computer's key on the machine. Never stored.
  r.route('POST', '/machines/:id/let-in', known(async (c, id) => c.send(200, await machines.letIn(id, String((await c.body()).password || '')))));
  r.route('POST', '/machines/:id/connect', known(async (c, id) => c.send(200, await machines.connect(id))));
  r.route('POST', '/machines/:id/disconnect', known((c, id) => c.send(200, (machines.disconnect(id), one(id)))));
  // Stop wisp over there (its agents too); restart starts this version in its place.
  r.route('POST', '/machines/:id/stop', known(async (c, id) => c.send(200, (await machines.stopRemote(id, { restart: !!(await c.body()).restart }), one(id)))));
  // Sign in to a harness over there (its own login, run on that computer): passed through to its
  // wisp. Once it's in or out, its harness list here is looked up again.
  const there = (method, rest, after) =>
    known(async (c, id) => {
      const body = method === 'GET' || method === 'DELETE' ? undefined : await c.body();
      const v = await machines.json(id, method, `/agents/${encodeURIComponent(c.params.aid)}/${typeof rest === 'function' ? rest(c) : rest}`, body);
      if (after?.(v)) machines.recheckAgents([id, c.params.aid]).catch(() => {});
      c.send(200, v);
    });
  r.route('GET', '/machines/:id/agents/:aid/login', there('GET', 'login', (v) => v.state === 'done'));
  r.route('POST', '/machines/:id/agents/:aid/login', there('POST', 'login'));
  r.route('DELETE', '/machines/:id/agents/:aid/login', there('DELETE', 'login'));
  r.route('POST', '/machines/:id/agents/:aid/login/input', there('POST', 'login/input'));
  r.route('POST', '/machines/:id/agents/:aid/logout', there('POST', 'logout', () => true));
  r.route('GET', '/machines/:id/agents/:aid/keys', there('GET', 'keys'));
  r.route('POST', '/machines/:id/agents/:aid/keys', there('POST', 'keys', () => true));
  r.route('DELETE', '/machines/:id/agents/:aid/keys/:provider', there('DELETE', (c) => `keys/${encodeURIComponent(c.params.provider)}`, () => true));
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
