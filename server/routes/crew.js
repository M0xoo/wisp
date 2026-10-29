// The crew (server/crew.js): long-lived agents with a name, a role, a schedule and a memory, whose
// work runs as tasks. Add one, turn a task into one, hand one work, check in now.

import { summarize } from '../runner.js';
import { bad } from '../util.js';
import { splitId } from '../machines.js';
import { crewMentions, localKit, MAX_CREW } from '../crew.js';
import { applyImport, createGist, exportCrew, parseCrewFile, planImport } from '../crew-share.js';
import { fetchShared } from './spells.js';
import { crewStats } from '../usage.js';
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
  // "Also starts when" (body.on: ['finished', 'done', 'ci']): the triggers that send the member
  // work. When that's refused (CI with no project), a new member goes and an edit is undone.
  const syncOn = (m, body, { prevCwd, undo }) => {
    if (!Array.isArray(body.on)) return;
    // A spell's member: the spell says what starts them (Resume sends that, to make its triggers).
    if (m.spell && JSON.stringify([...new Set(body.on)].sort()) !== JSON.stringify(m.spell.def.on)) {
      undo();
      throw bad(`${m.name} comes from the “${m.spell.name}” spell, which sets what starts them. Make them yours first (Make it mine).`, 409);
    }
    try {
      app.triggers.syncMember(m, body.on, { prevCwd });
    } catch (err) {
      undo();
      throw err;
    }
  };
  const started = (m, out) => (out.session ? { session: sumOf(out.session), member: crew.view(m) } : { queued: out.queued, member: crew.view(m) });

  // Skills and instructions files on this computer, to add to a member's kit (cwd: its project's too).
  r.route('GET', '/crew-kit', (c) => c.send(200, localKit({ home: os.homedir(), cwd: c.query.get('cwd') || '' })));
  r.route('GET', '/crew', (c) => c.send(200, crew.list.map((m) => crew.view(m))));
  // Where you put each member on the Org page (web/js/features/org.js): { [id]: { x, y } }, x from
  // the chart's middle, y from its top, in px. Empty: the chart lays itself out.
  const layout = () => {
    const ids = new Set(crew.list.map((m) => m.id));
    return Object.fromEntries(Object.entries(store.config.crewLayout || {}).filter(([id]) => ids.has(id)));
  };
  r.route('GET', '/crew-layout', (c) => c.send(200, layout()));
  r.route('PUT', '/crew-layout', async (c) => {
    const body = await c.body();
    const raw = body?.layout;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('layout must be { [member id]: { x, y } }.');
    const out = {};
    for (const m of crew.list) {
      const p = raw[m.id];
      if (p === undefined) continue;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw bad(`Where ${m.name} sits needs a number x and y.`);
      out[m.id] = { x: Math.round(Math.min(20000, Math.max(-20000, p.x))), y: Math.round(Math.min(20000, Math.max(0, p.y))) };
    }
    store.config.crewLayout = out;
    store.saveConfig();
    c.send(200, out);
  });
  // checkin: true starts a first check-in right away (so a new member shows what it does).
  r.route('POST', '/crew', async (c) => {
    const body = await c.body();
    const m = crew.create(body);
    syncOn(m, body, { undo: () => crew.remove(m) });
    const out = body.checkin === true ? await crew.checkin(m).catch(() => ({})) : {};
    c.send(201, { ...crew.view(m), ...(out.session && { session: sumOf(out.session) }) });
  });
  // Each member's track record over the last `days` (and the range before, for the change).
  r.route('GET', '/crew/stats', (c) => c.send(200, crewStats(crew.list, (m) => crew.jobs(m), { days: Math.min(Math.max(Number(c.query.get('days')) || 30, 1), 365), sessions: store.all(), budget: app.budget })));
  r.route('GET', '/crew/:id', member((c, m) => c.send(200, { ...crew.view(m), jobList: crew.jobs(m).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(sumOf) })));
  r.route(
    'PATCH',
    '/crew/:id',
    member(async (c, m) => {
      const body = await c.body();
      if (Array.isArray(body.queue)) m.queue = m.queue.filter((w) => body.queue.includes(w.id)); // drop waiting jobs
      const before = { ...m };
      crew.update(m, body);
      // Offers you added or dismissed (after the kit they added to was accepted).
      for (const o of Array.isArray(body.offers) ? body.offers : []) if (o && typeof o === 'object') crew.settleOffer(m, String(o.id || ''), { state: o.state, names: Array.isArray(o.names) ? o.names : [] });
      syncOn(m, body, { prevCwd: before.cwd, undo: () => (Object.assign(m, before), store.saveConfig()) });
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

  // Make a spell's member yours: the spell no longer changes them, and you can change anything.
  r.route(
    'POST',
    '/crew/:id/detach',
    member((c, m) => {
      if (!m.spell) throw bad(`${m.name} is already yours.`);
      crew.detach(m);
      c.send(200, crew.view(m));
    }),
  );

  // Share members (ids: ids, names or handles): the .crew.json file, notes on what stays here, and
  // with gist: true a secret gist of it. Nothing leaves while the secret scan finds anything.
  r.route('POST', '/crew/export', async (c) => {
    const body = await c.body();
    const out = exportCrew(crew, body.ids, { kit: body.kit !== false, notebook: body.notebook === true, team: body.team === true });
    if (out.hits.length) {
      const where = out.hits.map((h) => `${h.what} in ${h.where}, line ${h.line}`);
      return c.send(422, { error: `That looks like a secret: ${where.join('; ')}. Take it out before you share.`, hits: out.hits });
    }
    const names = out.bundle.members.map((b) => b.name).join(', ');
    const gist = body.gist === true ? await createGist(out.bundle, out.file, { description: `${names}: ${out.bundle.members.length > 1 ? 'wisp crew members' : 'a wisp crew member'}` }) : null;
    app.telemetry?.track('crew_shared', { members: out.bundle.members.length, gist: !!gist, notebook: body.notebook === true });
    c.send(200, { bundle: out.bundle, notes: out.notes, file: out.file, ...(gist && { gist }) });
  });

  // Add shared members ({ text } pasted or a file's text, { url } https or gist:<id>, or { bundle }).
  // dryRun: the review: who joins, as what name, on which harness, and who needs a project.
  // choices: { [key]: { name, cwd, skip } } from the review. They join paused. A spell answers
  // { spell } instead, for the spell review.
  r.route('POST', '/crew/import', async (c) => {
    const body = await c.body();
    let json = body.bundle;
    let source = { kind: 'file' };
    if (body.url) ({ json, source } = await fetchShared(body.url, 'crew'));
    else if (typeof body.text === 'string') {
      try {
        json = JSON.parse(body.text);
      } catch (err) {
        throw bad(`That isn't JSON (or a link): ${err.message}`);
      }
    }
    if (!json) throw bad('Paste a crew file, or a link to one (https or gist:<id>).');
    const parsed = parseCrewFile(json);
    if (parsed.spell) return c.send(200, { spell: parsed.spell, source });
    const agents = (await app.auto?.agents?.().catch(() => null)) || [];
    const choices = body.choices && typeof body.choices === 'object' ? body.choices : {};
    const plan = planImport(parsed.members, { crew, agents, choices });
    if (body.dryRun === true) return c.send(200, { members: plan, source, room: MAX_CREW - crew.list.length });
    const made = applyImport(plan, { crew, triggers: app.triggers });
    app.telemetry?.track('crew_imported', { members: made.length, source: source.kind });
    c.send(201, { members: made.map((m) => crew.view(m)) });
  });

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
      syncOn(m, body, { undo: () => crew.remove(m) });
      return c.send(201, crew.view(m));
    }
    if (!s) return c.send(404, { error: 'no such session' });
    if (s.crew && crew.get(s.crew.id)) throw bad(`This task is already ${crew.get(s.crew.id).name}’s.`, 409);
    if (s.parentId || s.agent === 'wisp') throw bad('Only a task of your own can join the crew.');
    const body = await c.body();
    const m = crew.adopt(s, body);
    syncOn(m, body, { undo: () => (crew.remove(m), delete s.crew, store.save(s)) });
    app.sessionChanged(s);
    c.send(201, crew.view(m));
  });
}
