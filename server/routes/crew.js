// The crew (server/crew.js): long-lived agents with a name, a role, a schedule and a memory, whose
// work runs as tasks. Add one, turn a task into one, hand one work, check in now.

import { summarize } from '../runner.js';
import { bad } from '../util.js';
import { splitId } from '../machines.js';
import { crewMentions, localKit } from '../crew.js';
import os from 'node:os';

export function register(r, app) {
  const { store, crew } = app;
  const member = (fn) => (c) => {
    const m = crew.find(c.params.id);
    if (!m) return c.send(404, { error: 'no such crew member' });
    return fn(c, m);
  };
  // A job just started is a session; one waiting for room is its place in the queue.
  // A job on the member's machine is already a summary.
  const sumOf = (x) => (x.turns ? summarize(x, store) : x);
  const started = (m, out) => (out.session ? { session: sumOf(out.session), member: crew.view(m) } : { queued: out.queued, member: crew.view(m) });

  // Skills and instructions files on this computer, to add to a member's kit (cwd: its project's too).
  r.route('GET', '/crew-kit', (c) => c.send(200, localKit({ home: os.homedir(), cwd: c.query.get('cwd') || '' })));
  r.route('GET', '/crew', (c) => c.send(200, crew.list.map((m) => crew.view(m))));
  // checkin: true starts a first check-in right away (so a new member shows what it does).
  r.route('POST', '/crew', async (c) => {
    const body = await c.body();
    const m = crew.create(body);
    const out = body.checkin === true ? await crew.checkin(m).catch(() => ({})) : {};
    c.send(201, { ...crew.view(m), ...(out.session && { session: sumOf(out.session) }) });
  });
  r.route('GET', '/crew/:id', member((c, m) => c.send(200, { ...crew.view(m), jobList: crew.jobs(m).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(sumOf) })));
  r.route(
    'PATCH',
    '/crew/:id',
    member(async (c, m) => {
      const body = await c.body();
      if (Array.isArray(body.queue)) m.queue = m.queue.filter((w) => body.queue.includes(w.id)); // drop waiting jobs
      crew.update(m, body);
      // Offers you added or dismissed (after the kit they added to was accepted).
      for (const o of Array.isArray(body.offers) ? body.offers : []) if (o && typeof o === 'object') crew.settleOffer(m, String(o.id || ''), { state: o.state, names: Array.isArray(o.names) ? o.names : [] });
      c.send(200, crew.view(m));
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
      const { prompt: asked, attachments, kit } = await c.body();
      // kit: build their kit (they propose skills and instructions files; you pick).
      const prompt = String(asked || '').trim() || (kit === true ? `Build your kit: make yourself excellent${m.role ? ` as our ${m.role}` : ' at your job'}.` : '');
      if (!prompt) throw bad('Tell them what to do.');
      // @Quill in it: Quill joins this job's delegates.
      const tagged = crewMentions(String(prompt), crew.list).all;
      c.send(201, started(m, await crew.assign(m, { prompt, job: 'task', attachments: Array.isArray(attachments) ? attachments : [], tagged, kit: kit === true })));
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

  // You reply to a member's answer on a task: its job carries on, the answer lands under yours.
  r.route('POST', '/sessions/:id/crew-reply', async (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    const { entry, text } = await c.body();
    if (!String(text || '').trim()) throw bad('Type your reply first.');
    c.send(201, await crew.replyIn(s, String(entry || ''), String(text).trim()));
  });

  // A task joins the crew: it becomes the new member's first job.
  r.route('POST', '/sessions/:id/crew', async (c) => {
    const s = store.get(c.params.id);
    // A task on a machine: the member lives on that machine, with the task's folder and harness.
    const away = !s && splitId(c.params.id);
    if (away) {
      const sum = (await app.machines.sessions({}, { only: away.machine })).find((x) => x.id === c.params.id);
      if (!sum) return c.send(404, { error: 'no such session' });
      const body = await c.body();
      const m = crew.create({ machine: away.machine, cwd: sum.scratch ? '' : sum.cwd, agent: sum.agent, model: sum.model, effort: sum.effort, mode: sum.mode, brief: sum.title, ...body });
      return c.send(201, crew.view(m));
    }
    if (!s) return c.send(404, { error: 'no such session' });
    if (s.crew && crew.get(s.crew.id)) throw bad(`This task is already ${crew.get(s.crew.id).name}’s.`, 409);
    if (s.parentId || s.agent === 'wisp') throw bad('Only a task of your own can join the crew.');
    const m = crew.adopt(s, await c.body());
    app.sessionChanged(s);
    c.send(201, crew.view(m));
  });
}
