// Moving a task to another place (this computer or a machine) with a follow-up. A session lives on
// the wisp that runs it, so the move starts a new session there that carries the task on:
//
//   pack     the source packs each folder's work (git.js packWork: the branch, plus a snapshot
//            of what isn't committed) into bundles, kept as uploads there.
//   carry    the bundles travel through this wisp to the target, like attachments do.
//   launch   the target gets the project's checkout (services/places.js), unpacks each bundle into
//            a worktree on the same branch, and starts the follow-up with the earlier turns as
//            its history: the harness there hears them first (handoff.js).
//   retire   the old session is archived, pointing at the new one.

import os from 'node:os';
import { listAgents, adapters } from '../adapters/index.js';
import { packWork, unpackWork } from '../git.js';
import { splitId } from '../machines.js';
import { workdir } from '../runner.js';
import { bad } from '../util.js';

export function createMove(app) {
  const { store, machines, uploads } = app;
  // What a place is called in a moved task's history: the machine's name, or this computer's.
  const where = (mid) => (mid ? machines.get(mid).name : os.hostname().replace(/\.local$/, '') || 'this computer');

  // Source side: the session and its folders' bundles. A running task has nothing settled to pack.
  async function pack(s) {
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to move it.');
    if (s.parentId) throw bad('A subagent runs where its lead does.');
    if (s.state === 'running' || s.state === 'waiting') throw bad('Stop the task or let it finish first: a running task can’t move.', 409);
    const one = async (dir, wt) => {
      const u = uploads.reserve('work.bundle');
      const out = await packWork(dir, wt, u.file).catch((err) => {
        throw bad(`Couldn’t pack the work in ${dir}: ${err.message}`);
      });
      return out && { ...out, upload: u.add().id };
    };
    const scratch = store.isScratch(s.cwd);
    const packs = scratch ? [] : [await one(workdir(s), s.worktree), ...(await Promise.all((s.also || []).map((a) => one(a.worktree?.cwd || a.cwd, a.worktree))))];
    return { session: s, scratch, packs };
  }

  // Target side (launch.js): the worktrees for a moved launch, one per folder, from the bundles.
  async function unpack(dirs, packs, { id, title }) {
    return Promise.all(
      dirs.map(async (cwd, i) => {
        const p = packs?.[i];
        const u = p && uploads.get(p.upload);
        if (!p || !u) return null;
        try {
          return await unpackWork({ cwd, home: store.home, id, title, pack: p, file: u.path });
        } finally {
          uploads.remove(u.id);
        }
      }),
    );
  }

  // A bundle from the source (null = here) as an upload on the target.
  async function carry(upload, from, to) {
    let u = from ? null : uploads.get(upload);
    if (from) u = await uploads.receive(await machines.stream(from, 'GET', `/uploads/${upload}`, { timeout: 10 * 60_000 }), { name: 'work.bundle', type: 'application/octet-stream' });
    if (!u) throw bad('The packed work went missing on its way.', 500);
    if (!to) return u.id;
    const there = await machines.upload(to, u);
    uploads.remove(u.id); // the copy here was only on its way through
    return there.id;
  }

  // The earlier turns, as history for the new session: what ran where, without what only made
  // sense there (checkpoints, attachment files, subagent sessions).
  const history = (s, from) =>
    s.turns.map((t) => {
      const { checkpoint, delegations, attachments, ...rest } = t;
      return { ...rest, moved: t.moved || where(from), checkpoint: null, ...(t.status === 'running' && { status: 'stopped' }) };
    });

  // id: the session as this wisp names it (<id>@<machine> on a machine). to: a machine id, or
  // null for this computer. Resolves the new session's summary.
  async function move(id, to, { text, attachments = [], mode, agent, model, effort } = {}) {
    const at = splitId(id);
    const from = at?.machine || null;
    to = to || null;
    if (from === to) throw bad('The task is already there.');
    if (to) machines.get(to);
    if (to && !machines.usable(to)) throw bad(`${machines.get(to).name} is offline. Connect it from Machines.`, 503);
    const local = !from && store.get(id);
    if (!from && !local) throw bad('no such session', 404);
    const src = from ? await machines.json(from, 'GET', `/sessions/${at.id}`) : local;
    // The harness the follow-up runs on has to be there.
    const run = { agent: agent || src.agent, model: model ?? (agent && agent !== src.agent ? '' : src.model || ''), effort: effort ?? (agent && agent !== src.agent ? '' : src.effort || '') };
    const there = to ? machines.agentsOf(to) || [] : await listAgents();
    if (!there.some((a) => a.id === run.agent && a.available)) throw bad(`${adapters[run.agent]?.name || run.agent} isn’t installed on ${where(to)}. Pick another harness for this follow-up.`);

    const packed = from ? await machines.json(from, 'POST', `/sessions/${at.id}/pack`, {}, { timeout: 10 * 60_000 }) : await pack(local);
    const s = from ? machines.session(from, packed.session) : packed.session;
    const packs = await Promise.all(packed.packs.map(async (p) => p && { ...p, upload: await carry(p.upload, from, to) }));
    if (from) for (const p of packed.packs) if (p) machines.json(from, 'DELETE', `/uploads/${p.upload}`).catch(() => {});

    const body = {
      prompt: text,
      ...(packed.scratch ? { scratch: true } : { cwd: s.cwd, also: (s.also || []).map((a) => a.cwd) }),
      machine: to || '',
      agent: run.agent,
      model: run.model,
      effort: run.effort,
      mode: mode || s.mode,
      attachments,
      ...(s.groupId && { groupId: s.groupId }),
      ...(s.subagents?.length && { subagents: s.subagents }),
      moved: { from: where(from), title: s.title, turns: history(s, from), packs, ...(s.origin && { origin: s.origin }) },
    };
    let next;
    try {
      [next] = await app.launcher.launchAny(body);
    } catch (err) {
      for (const p of packs) if (p) (to ? machines.json(to, 'DELETE', `/uploads/${p.upload}`) : Promise.resolve(uploads.remove(p.upload))).catch(() => {});
      throw err;
    }
    // The old one steps aside: archived (its worktree stays until you delete it), pointing here.
    const movedTo = { id: next.id, place: where(to) };
    if (from) await machines.json(from, 'PATCH', `/sessions/${at.id}`, { archived: true, movedTo }).catch(() => {});
    else {
      Object.assign(local, { archived: true, unread: false, movedTo });
      app.sessionChanged(local);
    }
    app.telemetry?.track('move_task', { from: from ? 'machine' : 'here', to: to ? 'machine' : 'here', agent: run.agent });
    return { moved: true, from: id, session: next };
  }

  return { pack, unpack, move };
}
