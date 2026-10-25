// The crew (server/crew.js): long-lived agents with a name, a role, a schedule and a memory, whose
// work runs as tasks. Add one, turn a task into one, hand one work, check in now.

import { summarize } from '../runner.js';
import { bad } from '../util.js';

export function register(r, app) {
  const { store, crew } = app;
  const member = (fn) => (c) => {
    const m = crew.find(c.params.id);
    if (!m) return c.send(404, { error: 'no such crew member' });
    return fn(c, m);
  };
  // A job just started is a session; one waiting for room is its place in the queue.
  const started = (m, out) => (out.session ? { session: summarize(out.session, store), member: crew.view(m) } : { queued: out.queued, member: crew.view(m) });

  r.route('GET', '/crew', (c) => c.send(200, crew.list.map((m) => crew.view(m))));
  // checkin: true starts a first check-in right away (so a new member shows what it does).
  r.route('POST', '/crew', async (c) => {
    const body = await c.body();
    const m = crew.create(body);
    const out = body.checkin === true ? await crew.checkin(m).catch(() => ({})) : {};
    c.send(201, { ...crew.view(m), ...(out.session && { session: summarize(out.session, store) }) });
  });
  r.route('GET', '/crew/:id', member((c, m) => c.send(200, { ...crew.view(m), jobList: crew.jobs(m).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((s) => summarize(s, store)) })));
  r.route(
    'PATCH',
    '/crew/:id',
    member(async (c, m) => {
      const body = await c.body();
      if (Array.isArray(body.queue)) m.queue = m.queue.filter((w) => body.queue.includes(w.id)); // drop waiting jobs
      c.send(200, crew.view(crew.update(m, body)));
    }),
  );
  r.route(
    'DELETE',
    '/crew/:id',
    member((c, m) => {
      crew.remove(m);
      c.send(200, { ok: true });
    }),
  );
  r.route(
    'POST',
    '/crew/:id/jobs',
    member(async (c, m) => {
      const { prompt, attachments } = await c.body();
      if (!String(prompt || '').trim()) throw bad('Tell them what to do.');
      c.send(201, started(m, await crew.assign(m, { prompt, job: 'task', attachments: Array.isArray(attachments) ? attachments : [] })));
    }),
  );
  r.route(
    'POST',
    '/crew/:id/checkin',
    member(async (c, m) => {
      const out = await crew.checkin(m);
      if (out.already) return c.send(409, { error: `${m.name} is already checking in.` });
      c.send(201, started(m, out));
    }),
  );

  // A task joins the crew: it becomes the new member's first job.
  r.route('POST', '/sessions/:id/crew', async (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    if (s.crew && crew.get(s.crew.id)) throw bad(`This task is already ${crew.get(s.crew.id).name}’s.`, 409);
    if (s.parentId || s.agent === 'wisp') throw bad('Only a task of your own can join the crew.');
    const m = crew.adopt(s, await c.body());
    app.sessionChanged(s);
    c.send(201, crew.view(m));
  });
}
