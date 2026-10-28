// Delegates on other machines. The lead's wisp keeps a hidden child session per member, as for any
// subagent, but runs nothing for a member that's elsewhere (member.machine). This wisp, the one the
// page talks to and the only one that reaches every place, carries each such delegation over:
//
//   claim    the lead's wisp packs the lead's work (git.js packWork), like a move does
//   launch   the member's place gets the project's checkout and a worktree holding that work
//            (services/move.js unpack), and runs the task as a `delegated` session: hidden, no
//            questions, with the member's earlier turns there as its history
//   watch    its live line shows on the lead's card while it works; stopping the lead stops it
//   return   its changes come back as a patch (git.js workPatch), applied to the lead's folder
//            with its report; the session over there is deleted
//
// A lead here hands its delegations over in-process (runner 'relay' events). A lead on a machine
// lists them in its summary (relays) and this wisp picks them up from that machine's events.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, packWork, removeWorktree, workPatch } from '../git.js';
import { cleanupCheckpoints } from '../checkpoint.js';
import { splitId } from '../machines.js';
import { summarize, workdir } from '../runner.js';
import { HERE } from '../store.js';
import { bad } from '../util.js';

const WAIT_S = 5; // each long-poll on the member's run
const MAX_PATCH = 50 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRelay(app) {
  const { store, runner, machines } = app;
  const inflight = new Set(); // `${lead place}:${child}:${turn}` being carried over
  const here = () => os.hostname().replace(/\.local$/, '') || 'this computer';
  const placeName = (k) => (!k || k === HERE ? here() : machines.get(k).name);

  // A team as the wisp at `mid` (null = this one) runs it: a member on that same place goes with
  // the lead (''), the others keep their place and its name, and are marked upstream when that
  // wisp is a machine (this one runs them, it can't). Here, members the wisp that sent the task
  // placed (upstream) stay as they are: their machine ids are that wisp's.
  function placeTeam(list, mid = null) {
    if (!Array.isArray(list)) return list;
    return list.map((m) => {
      if (!mid && m?.upstream === true) return m;
      const { upstream, place, ...rest } = m || {};
      // The crew is this wisp's: a machine's wisp doesn't have it, so this one starts their jobs.
      if (m?.crew) return mid ? { ...rest, upstream: true } : rest;
      const k = typeof m?.machine === 'string' ? m.machine : '';
      if (!k || k === (mid || HERE)) return { ...rest, machine: '' };
      if (k !== HERE) machines.get(k); // a machine this wisp knows, or a clear error
      return { ...rest, machine: k, place: placeName(k), ...(mid && { upstream: true }) };
    });
  }

  // --- the lead's side (its wisp: this one, or a machine through POST /sessions/:id/relay) ------

  // op: claim (pack the lead's work and say what to run), progress (its live line; answers
  // whether the lead stopped it) or finish (apply its patch, land its report).
  async function op(child, body = {}) {
    const lead = child?.parentId && store.get(child.parentId);
    const turn = child?.turns.find((t) => t.id === body.turn);
    if (!lead || !child.relay || !turn?.relay) throw bad('No such delegation.', 404);
    if (body.op === 'claim') {
      if (turn.status !== 'running' || turn.relay.state !== 'pending') throw bad('That delegation was already picked up.', 409);
      turn.relay.state = 'running';
      runner.relayed(child, turn, { kind: 'agent', label: `Sending to ${child.relay.place || 'the machine'}` });
      // A crew member: it works in its own folder, so there's no work to pack.
      if (child.relay.crew) return { crew: child.relay.crew, label: child.relay.place, prompt: turn.prompt, lead: lead.id, title: lead.title, name: child.member };
      const scratch = store.isScratch(lead.cwd);
      let pack = null;
      if (!scratch) {
        const u = app.uploads.reserve('work.bundle');
        const out = await packWork(workdir(lead), lead.worktree, u.file).catch((err) => {
          throw bad(`Couldn’t pack the lead’s work: ${err.message}`);
        });
        if (out) pack = { ...out, branch: '', upload: u.add().id }; // a branch of its own over there
      }
      const history = child.turns.filter((t) => t !== turn && t.status !== 'running').map(({ checkpoint, delegations, attachments, relay, ...t }) => ({ ...t, checkpoint: null }));
      return { prompt: turn.prompt, agent: child.agent, model: child.model, effort: child.effort || '', mode: child.mode, cwd: lead.cwd, scratch, title: lead.title, name: child.member, history, pack };
    }
    if (body.op === 'progress') {
      if (turn.status === 'running' && body.item?.label) runner.relayed(child, turn, body.item);
      return { stopped: turn.status !== 'running' };
    }
    if (body.op === 'finish') {
      if (turn.status !== 'running') return { stopped: true };
      const patch = String(body.patch || '');
      const applied = patch ? await applyPatch(workdir(lead), patch) : { empty: true };
      // A patch that didn't go in is kept, so the work isn't lost.
      if (patch && !applied.applied) {
        applied.file = path.join(store.home, 'patches', `${child.id}-${turn.id}.patch`);
        fs.mkdirSync(path.dirname(applied.file), { recursive: true });
        fs.writeFileSync(applied.file, patch);
      }
      runner.relayDone(child, turn, { ...body, applied });
      return { ok: true, applied };
    }
    throw bad('op must be claim, progress or finish.');
  }

  const leadCall = (mid, childId, body) => (mid ? machines.json(mid, 'POST', `/sessions/${childId}/relay`, body, { timeout: 10 * 60_000 }) : op(store.get(childId), body));

  // --- the member's side: where it runs (null = this computer) ---------------------------------

  const member = (where) => ({
    async state(id) {
      if (where) return machines.json(where, 'GET', `/sessions/${id}/wait?timeout=${WAIT_S}`, undefined, { timeout: (WAIT_S + 30) * 1000 });
      await sleep(1500);
      const s = store.get(id);
      if (!s) throw bad('The delegate’s session went away.');
      return summarize(s, store);
    },
    session: (id) => (where ? machines.json(where, 'GET', `/sessions/${id}`) : store.get(id)),
    patch: async (id) => (where ? (await machines.json(where, 'GET', `/sessions/${id}/patch`, undefined, { timeout: 5 * 60_000 })).patch : patchOf(store.get(id))),
    stop: (id) => (where ? machines.json(where, 'POST', `/sessions/${id}/stop`, {}) : store.get(id) && runner.stop(store.get(id))),
    async remove(id) {
      if (where) return machines.json(where, 'DELETE', `/sessions/${id}`);
      const s = store.get(id);
      if (s) await removeSession(s);
    },
  });

  // GET /sessions/:id/patch: what a delegated run changed since the work it was handed.
  async function patchOf(s) {
    if (!s?.delegated) throw bad('Only a delegate’s run has a patch to send back.', 404);
    const patch = await workPatch(workdir(s), s.worktree?.snap);
    if (patch.length > MAX_PATCH) throw bad(`The changes are too big to send back (${Math.round(patch.length / 1048576)} MB).`, 413);
    return patch;
  }

  // A delegate's run is done with: its worktree and branch go with it (the lead has the changes).
  async function removeSession(s) {
    runner.stop(s);
    await runner.live.get(s.id)?.done;
    cleanupCheckpoints(workdir(s), s.id);
    if (s.worktree) await removeWorktree(s.worktree, { force: true, branch: 'force' }).catch(() => {});
    store.delete(s.id);
    app.broadcast('removed', { id: s.id });
  }

  // One delegation, start to end. lead: the lead's place (null = here). r: { child, turn, machine }.
  async function carry(lead, r) {
    const key = `${lead || HERE}:${r.child}:${r.turn}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    let job;
    try {
      job = await leadCall(lead, r.child, { op: 'claim', turn: r.turn });
    } catch (err) {
      inflight.delete(key);
      if (err.status !== 409) console.warn(`wisp: delegate: ${err.message}`);
      return;
    }
    const finish = (body) => leadCall(lead, r.child, { op: 'finish', turn: r.turn, ...body });
    if (job.crew) return carryCrew(lead, r, job, finish).finally(() => inflight.delete(key));
    const where = r.machine === HERE ? null : r.machine;
    const there = member(where);
    let rid = null;
    try {
      if (where) {
        machines.get(where);
        if (!machines.usable(where)) throw bad(`${machines.get(where).name} is offline. Connect it from Machines, then delegate again.`, 503);
      }
      // The packed work: from the lead's wisp to the member's, through this one.
      const packs = job.pack ? [{ ...job.pack, upload: await app.mover.carry(job.pack.upload, lead, where) }] : [];
      if (lead && job.pack) machines.json(lead, 'DELETE', `/uploads/${job.pack.upload}`).catch(() => {});
      const [s] = await app.launcher.launchAny({
        prompt: job.prompt,
        ...(job.scratch ? { scratch: true } : { cwd: job.cwd }),
        machine: where || '',
        agent: job.agent,
        model: job.model,
        effort: job.effort,
        mode: job.mode,
        delegated: { lead: job.title, name: job.name },
        moved: { from: placeName(lead), title: job.title, turns: job.history, packs },
      });
      rid = where ? splitId(s.id).id : s.id;
      // Its live line on the lead's card, until it settles or the lead stops it.
      let last = '';
      for (;;) {
        const sum = await there.state(rid);
        const settled = sum.state !== 'running' && !sum.queued;
        if (settled) break;
        const label = sum.live || 'Working';
        const res = await leadCall(lead, r.child, { op: 'progress', turn: r.turn, ...(label !== last && { item: { kind: 'agent', label } }) });
        last = label;
        if (res.stopped) {
          await there.stop(rid).catch(() => {});
          return;
        }
      }
      const out = await there.session(rid);
      const t = out.turns.at(-1);
      const root = out.worktree?.cwd || out.cwd;
      // Edits as paths in the folder, so they line up with the lead's.
      const rel = (f) => (path.isAbsolute(f) || f.startsWith('/') ? path.posix.relative(root.replace(/\\/g, '/'), f.replace(/\\/g, '/')) : f);
      const changes = (t?.changes || []).map((c) => ({ file: rel(c.file), op: c.op, edits: c.edits || [] })).filter((c) => c.file && !c.file.startsWith('..'));
      const patch = job.pack ? await there.patch(rid) : '';
      await finish({ status: t?.status || 'error', presentation: t?.presentation || null, stats: t?.stats || null, changes, patch, agent: out.agent, model: out.model, effort: out.effort || '', kept: !job.pack && !job.scratch });
    } catch (err) {
      await finish({ status: 'error', error: err.message }).catch(() => {});
    } finally {
      inflight.delete(key);
      if (rid) there.remove(rid).catch(() => {});
    }
  }

  // A crew member delegated to by a lead on a machine: the crew is this wisp's, so it starts the
  // member's job here (or on the member's own machine), a task the user sees like any crew job,
  // and hands its report to the lead. Its edits stay in the member's own folder.
  async function carryCrew(lead, r, job, finish) {
    try {
      if (!runner.crewDelegate) throw bad('The crew is not available.');
      const from = { id: lead ? `${job.lead}@${lead}` : job.lead, title: job.title };
      const s = await runner.crewDelegate(from, { crew: job.crew, label: job.label, name: job.name }, job.prompt);
      if (s.error) throw bad(s.error);
      const at = splitId(s.id);
      const there = member(at?.machine || null);
      const rid = at ? at.id : s.id;
      let last = '';
      for (;;) {
        const sum = await there.state(rid);
        if (sum.state !== 'running' && !sum.queued) break;
        const label = sum.live || 'Working';
        const res = await leadCall(lead, r.child, { op: 'progress', turn: r.turn, ...(label !== last && { item: { kind: 'agent', label } }) });
        last = label;
        if (res.stopped) return void (await there.stop(rid).catch(() => {}));
      }
      const out = await there.session(rid);
      const t = out.turns.at(-1);
      await finish({ status: t?.status || 'error', presentation: t?.presentation || null, stats: t?.stats || null, agent: out.agent, model: out.model, effort: out.effort || '' });
    } catch (err) {
      await finish({ status: 'error', error: err.message }).catch(() => {});
    }
  }

  // A lead here hands its delegations over at once; one on a machine through its summaries.
  runner.on('relay', ({ session, turn }) => carry(null, { child: session.id, turn: turn.id, machine: session.relay.machine }));
  function notice(sum) {
    const at = splitId(sum?.id);
    if (!at || !Array.isArray(sum.relays)) return;
    for (const r of sum.relays) if (r?.child && r.turn && r.machine) carry(at.machine, r);
  }
  // A machine back online may have delegations waiting since before.
  machines.on('online', (m) => {
    machines
      .sessions({}, { only: m.id })
      .then((list) => list.forEach(notice))
      .catch(() => {});
  });

  return { placeTeam, op, patchOf, notice, removeSession };
}
