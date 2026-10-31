// Sessions: list and launch, one session (read, edit, delete), and what can be done to it:
// wait, presentation, reply, btw, queue, answer, revert, rollback, exec, takeover, stop, file.
// Ids of the form <id>@<machine> are passed through to that machine's wisp (proxy.js).

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { adapters, listAgents } from '../adapters/index.js';
import { btwQuestion } from '../btw.js';
import { goalView } from '../goal.js';
import { cleanupCheckpoints, revertFileChange, rollbackToTurn } from '../checkpoint.js';
import { execCommand } from '../proc.js';
import { ensureWorktree, removeWorktree, worktreeSource } from '../git.js';
import { MIME } from '../http/static.js';
import { prepared, sendFile } from '../http/respond.js';
import { blocksToMarkdown, sessionToMarkdown } from '../render.js';
import { alsoDirs, listSummary, summarize, workdir } from '../runner.js';
import { normalizeTeam } from '../subagents.js';
import { crewMentions, taggedDelegate } from '../crew.js';
import { ptySupported } from '../pty.js';
import { defaultTerminal, inWisp, openInTerminal, shq } from '../terminal.js';
import { bad, clip, expand, MODES } from '../util.js';
import { APP_MAX_STATE } from '../../web/js/app-doc.js';
import { watchDoc } from '../watch.js';
import { TAKEOVER_NOTE, tuiArgv } from '../services/tui.js';

export const MAX_WAIT_S = 290; // long-poll cap per request; clients loop (fetch drops headers after 300s)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);
const MEDIA_BLOCKS = new Set(['image', 'video']);

// A picture or video the agent pointed at: the file on disk, if it's inside the session's project
// or the agent named that exact path in a block (screenshots often land in /tmp). `source` is
// where the agent saved it, when wisp shows a copy (store.keepImages).
export function mediaFile(s, asked) {
  const dir = workdir(s);
  let p = path.resolve(dir, asked || '');
  const media = s.turns.flatMap((t) => (t.presentation?.blocks || []).filter((b) => MEDIA_BLOCKS.has(b?.type)));
  const at = (v) => typeof v === 'string' && path.resolve(dir, v) === p;
  let block = media.find((b) => at(b.path || b.src));
  // A page rendered before keepImages() rewrote the block still asks for the original path.
  const kept = !block && media.find((b) => at(b.source) && typeof b.path === 'string');
  if (kept) (block = kept), (p = path.resolve(dir, kept.path));
  if (!(p.startsWith(dir + path.sep) || block) || !MEDIA_EXT.has(path.extname(p).toLowerCase()) || !fs.existsSync(p)) return null;
  const source = typeof block?.source === 'string' ? path.resolve(dir, block.source) : null;
  return { path: p, source: source && fs.existsSync(source) ? source : null };
}

// A markdown file a doc block showed (Store.keepDocs): inside the project, or the path it named.
export function docFile(s, asked) {
  if (!asked) return null;
  const dir = workdir(s);
  const p = path.resolve(dir, asked);
  const named = s.turns.some((t) => (t.presentation?.blocks || []).some((b) => b?.type === 'doc' && [b.abs, b.path].some((v) => typeof v === 'string' && path.resolve(dir, v) === p)));
  if (!(p.startsWith(dir + path.sep) || named) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return { path: p, source: null };
}

// Shows a file selected in Finder / Explorer; other systems open its folder.
export function revealInFolder(file) {
  if (process.env.WISP_NO_OPEN === '1') return; // tests
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', file]] : process.platform === 'win32' ? ['explorer', [`/select,${file}`]] : ['xdg-open', [path.dirname(file)]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {}
}

// A session "needs you" once it stops running: finished, or blocked on ask_user. A finished run
// with follow-ups still queued is about to start the next one, so it doesn't count yet (unless a
// Stop held them: then nothing goes until you say).
const settled = (s) => s.state === 'waiting' || (s.state !== 'running' && (!s.queue?.length || !!s.queueHeld));

export function register(r, app) {
  const { store, runner, machines, telemetry, launcher } = app;

  // A route on one session of this computer: 404 if there is no such session.
  const one = (fn) => (c) => {
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    return fn(c, s);
  };
  // The welcome tour runs no agent: nothing to follow up, revert or roll back.
  const notTour = (s, what) => {
    if (s.agent === 'wisp') throw bad(`This is the tour — launch a real wisp to ${what}.`);
  };
  // A follow-up's harness switch, checked: a harness that's installed here, on a lead (not a subagent).
  const followUpRun = async (s, { agent, model, effort, account }) => {
    agent = agent ? String(agent) : s.agent;
    if (agent !== s.agent) {
      if (s.parentId) throw bad('A subagent runs on the harness its lead picked for it.');
      if (!adapters[agent]) throw bad(`Unknown harness: ${agent}`);
      const found = (await listAgents()).find((a) => a.id === agent);
      if (!found?.available) throw bad(`${adapters[agent].name} isn't installed on this computer.`);
    }
    return { agent, ...(model !== undefined && { model: String(model || '') }), ...(effort !== undefined && { effort: String(effort || '') }), ...(account !== undefined && { account: String(account || '') }) };
  };
  // A follow-up's new team, checked like a launch's: only a lead has one.
  const followUpTeam = (s, { subagents, preset }) => {
    if (s.parentId) throw bad('A subagent can’t have subagents of its own.');
    const p = preset ? store.config.teams.find((t) => t.id === preset) : null;
    if (preset && !p && subagents === undefined) throw bad(`no such subagent preset: ${preset}`);
    return normalizeTeam(app.relay.placeTeam(subagents ?? p?.members ?? [], null), adapters);
  };
  // Archiving removes clean worktrees: the task's own and its other folders' come back before it runs again.
  const ensureTrees = async (s) => {
    for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
  };
  // @Name in a prompt: a message that starts with members is addressed to them (lead); members
  // named further in join the task as delegates its agent can hand work to.
  const tagged = (text) => (app.crew?.list.length ? crewMentions(text, app.crew.list) : { all: [], lead: [], rest: text });
  const asDelegates = (members, have = []) =>
    members
      .filter((m) => !have.some((x) => x.crew === m.id))
      .map((m) => taggedDelegate(m));
  // "@Ada fix it with @Bo": Bo joins Ada's job as one of its delegates.
  const others = (t) => t.all.filter((m) => !t.lead.includes(m));
  // A crew job is a session here, or the summary of one on the member's machine.
  const sumOf = (x) => (x.turns ? summarize(x, store) : x);
  const turnOf = (s, turnId) => (turnId ? s.turns.find((t) => t.id === turnId) : s.turns.at(-1));

  // ?since=<token> (the phone, over a slow tunnel): only the tasks whose summary changed since the
  // list that token came with, and the ones gone since. Each list asked for this way is compared
  // with the one before it (a fingerprint per task), so nothing has to remember to mark a change.
  // A token from another run of wisp, or one older than what's kept, gets the whole list.
  const epoch = randomBytes(4).toString('hex');
  let seq = 0;
  const seen = new Map(); // id -> { hash, seq }
  const gone = new Map(); // id -> seq it went at
  let forgot = 0; // the newest removal no longer kept: a token older than it can't be diffed
  // A summary's hash, once per summary (listSummary keeps them while their task is unchanged).
  const hashes = new WeakMap();
  const hashOf = (x) => {
    let h = hashes.get(x);
    if (!h) hashes.set(x, (h = createHash('sha1').update(JSON.stringify(x)).digest('base64url')));
    return h;
  };
  // The whole list as last sent: the same summaries in the same order are the same answer, its
  // text, ETag and compressed copies made once (respond.js prepared).
  let lastList = { items: [], body: null };
  const sameList = (list) => {
    const a = lastList.items;
    if (a.length !== list.length || list.some((x, i) => x !== a[i])) lastList = { items: list, body: prepared(list) };
    return lastList.body;
  };
  const listDelta = (list, since) => {
    const now = new Set();
    for (const x of list) {
      now.add(x.id);
      const hash = hashOf(x);
      const was = seen.get(x.id);
      if (was?.hash !== hash) seen.set(x.id, { hash, seq: ++seq });
      gone.delete(x.id);
    }
    for (const id of seen.keys()) if (!now.has(id)) (seen.delete(id), gone.set(id, ++seq));
    while (gone.size > 5000) {
      const [id, at] = gone.entries().next().value;
      gone.delete(id);
      forgot = at;
    }
    const token = `${epoch}.${seq}`;
    const [e, n] = String(since).split('.');
    const from = Number(n);
    if (e !== epoch || !Number.isInteger(from) || from > seq || from < forgot) return { token, full: list };
    return { token, changed: list.filter((x) => seen.get(x.id).seq > from), removed: [...gone].filter(([, at]) => at > from).map(([id]) => id) };
  };
  r.route('GET', '/sessions', async (c) => {
    const q = Object.fromEntries(c.query);
    const since = q.since;
    delete q.since;
    const cwd = q.cwd && expand(q.cwd);
    // Subagent sessions belong to their lead; ?children=1 lists them too.
    // Sessions on machines too (the last ones seen, for a machine that's offline), unless another
    // wisp asks (?here=1): it wants this one's own, or two that list each other would ask in circles.
    const here = store.all().filter((x) => (!x.parentId && !x.delegated) || q.children).map((x) => listSummary(x, store));
    let list = [...here, ...(q.here ? [] : await machines.sessions(q))].sort((a, b) => b.updatedAt - a.updatedAt);
    if (q.state) list = list.filter((x) => q.state.split(',').includes(x.state));
    if (q.agent) list = list.filter((x) => x.agent === q.agent);
    // A task in several folders (also) shows under each of their projects.
    const dirs = (x) => [x.cwd, ...(x.also || []).map((a) => a.cwd)];
    if (q.project) list = list.filter((x) => [x, ...(x.also || [])].some((p) => p.projectId === q.project || p.project === q.project));
    if (cwd) list = list.filter((x) => dirs(x).some((d) => d === cwd || d?.startsWith(cwd + path.sep)));
    if (q.archived !== undefined) list = list.filter((x) => x.archived === (q.archived === 'true' || q.archived === '1'));
    if (Number(q.limit) > 0) list = list.slice(0, Number(q.limit));
    if (since !== undefined) return c.send(200, Object.keys(q).length ? { token: '', full: list } : listDelta(list, since)); // a filtered list isn't the one diffed
    c.send(200, Object.keys(q).length ? list : sameList(list));
  });
  // A task being typed (the launcher): its repo fetched now, so the launch doesn't wait on the
  // network for its worktree's base (git.js keeps a fetch for a minute). Answers at once.
  r.route('POST', '/launch/warm', async (c) => {
    const { cwd } = await c.body();
    const dir = typeof cwd === 'string' && cwd ? expand(cwd) : '';
    if (dir && store.config.defaults.worktree !== 'off' && !store.isScratch(dir) && fs.existsSync(dir)) worktreeSource(dir).catch(() => {});
    c.send(200, { ok: true });
  });
  r.route('POST', '/sessions', async (c) => {
    const body = await c.body();
    // A machine's wisp hands on where a recipe, trigger or Telegram launch came from.
    const o = body.origin;
    const origin = o && ['recipe', 'trigger', 'telegram', 'task'].includes(o.kind) ? { kind: o.kind, id: String(o.id || ''), name: String(o.name || '') } : null;
    // "@Ada check the deploy": a job for Ada (each member named first gets it), not a task of its own.
    const t = !body.machine && !body.kind ? tagged(String(body.prompt || '')) : { all: [], lead: [] };
    if (t.lead.length) {
      if (!t.rest) throw bad(`Tell ${t.lead.map((m) => m.name).join(' and ')} what to do after the name.`);
      const jobs = [];
      for (const m of t.lead) jobs.push({ m, out: await app.crew.assign(m, { prompt: t.rest, job: 'task', attachments: Array.isArray(body.attachments) ? body.attachments : [], tagged: others(t) }) });
      const list = jobs.map(({ m, out }) => (out.session ? sumOf(out.session) : { queued: out.queued, crew: { id: m.id, name: m.name } }));
      return c.send(201, list.length > 1 ? { ...list[0], group: list } : list[0]);
    }
    if (t.all.length) body.subagents = [...(body.subagents || store.config.teams.find((x) => x.id === body.preset)?.members || []), ...asDelegates(t.all, body.subagents || [])];
    const out = await launcher.launchAny(body, origin);
    c.send(201, out.length > 1 ? { ...out[0], group: out } : out[0]);
  });

  // A lead comes with its subagents' sessions, so its cards can show their reports and diffs.
  // ?lean=1 (the page): without each edit's whole file from before it, which only rollback reads
  // (here, on the server). A tenth or more of a big task, and the phone fetches it through a tunnel.
  // &turns=N (the phone): the latest N turns whole, older ones as stubs with what their folded row
  // shows (prompt, time, result title, mode and account); unfolding one fetches the task whole.
  const leanTurns = (turns) => turns?.map((t) => (t.changes?.some((x) => 'beforeFile' in x) ? { ...t, changes: t.changes.map(({ beforeFile, ...x }) => x) } : t));
  const STUB = ['id', 'prompt', 'by', 'goal', 'status', 'startedAt', 'endedAt', 'rolledBackAt', 'moved', 'mode', 'account', 'agent', 'model', 'effort', 'forked', 'shared', 'btw', 'checkpoint', 'held', 'attachments'];
  const stub = (t) => {
    const out = { stub: true };
    for (const k of STUB) if (t[k] !== undefined) out[k] = t[k];
    const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
    if (hero) out.presentation = { blocks: [{ type: 'hero', title: hero.title }] };
    return out;
  };
  const windowed = (turns, n) => (n > 0 && turns?.length > n ? turns.map((t, i) => (i < turns.length - n ? stub(t) : t)) : turns);
  const lean = (s, n) => ({
    ...s,
    turns: windowed(leanTurns(s.turns), n),
    ...(s.childSessions && { childSessions: Object.fromEntries(Object.entries(s.childSessions).map(([k, x]) => [k, { ...x, turns: leanTurns(x.turns) }])) }),
  });
  r.route(
    'GET',
    '/sessions/:id',
    one((c, s) => {
      app.ship.recheck(s, { lazy: true }); // edits made outside wisp (in an editor) show up too
      // Crew members' jobs it delegated count as its children here too.
      const kids = [...Object.values(s.children || {}), ...s.turns.flatMap((t) => (t.delegations || []).filter((d) => d.crew).map((d) => d.sessionId))];
      const out = kids.length ? { ...s, childSessions: Object.fromEntries(kids.map((cid) => [cid, store.get(cid) || runner.crewChild(cid)]).filter(([, x]) => x)) } : s;
      c.send(200, c.query.get('lean') === '1' ? lean(out, Number(c.query.get('turns')) || 0) : out);
    }),
  );
  r.route(
    'PATCH',
    '/sessions/:id',
    one(async (c, s) => {
      const body = await c.body();
      const park = body.forLater === true || (Number.isFinite(body.forLater) && body.forLater > 0); // a time: Undo puts it back in its place
      if (park && (s.state === 'running' || s.state === 'waiting' || s.ask || runner.live.has(s.id))) throw bad('Still working — save it for later once it’s finished.', 409);
      if (typeof body.title === 'string' && body.title.trim()) Object.assign(s, { title: body.title.trim(), titleAuto: false });
      const was = s.state;
      if (body.state === 'done' && s.state !== 'running') s.state = 'done';
      if (body.state === 'done' && s.state === 'done') app.later.done(s); // the agent's own wake-ups go; yours stay
      if (s.state === 'done' && was !== 'done') app.triggers?.taskEvent('done', s);
      if (body.state === 'review' && s.state === 'done') s.state = 'review';
      if (typeof body.unread === 'boolean') s.unread = body.unread;
      // Moved to another place by the wisp that shows it (services/move.js): where it went.
      if (body.movedTo && typeof body.movedTo === 'object') s.movedTo = { id: String(body.movedTo.id || ''), place: String(body.movedTo.place || '') };
      // The team can change between turns; the next turn's lead sees the new roster.
      if (body.subagents !== undefined && !s.parentId) {
        s.subagents = normalizeTeam(app.relay.placeTeam(body.subagents, null), adapters);
        s.children ||= {};
      }
      if (body.archived === true && s.state !== 'running' && s.state !== 'waiting') Object.assign(s, { archived: true, unread: false });
      if (body.archived === false) delete s.archived;
      // For later (design/for-later.md): parked to look at again. Marking it done, reopening or
      // archiving it takes it out; a task still working (or asking) can't be parked.
      // Applied after state and archived, so Undo can send { state: 'review', forLater: true }.
      if (body.forLater === false || body.state || s.archived) delete s.forLater;
      if (park && !s.archived) s.forLater = { at: Math.min(Number.isFinite(body.forLater) ? body.forLater : Date.now(), Date.now()), by: 'user' };
      if (s.state === 'done' || s.archived) app.retro.schedule(s, 0); // finished with it: learn now
      // Archived: a clean worktree goes (its branch stays, a follow-up brings it back).
      // discardWorktree: a compare run you didn't keep; its changes go too.
      if (s.archived) app.shells?.close(s.id); // its shell in the side panel goes with it
      if (!runner.live.has(s.id) && (s.archived || body.discardWorktree))
        for (const x of [s, ...(s.also || [])]) if (x.worktree) await removeWorktree(x.worktree, { force: !!body.discardWorktree, branch: !!body.discardWorktree && !x.pr && 'force' });
      app.sessionChanged(s);
      c.send(200, summarize(s, store));
    }),
  );
  r.route(
    'DELETE',
    '/sessions/:id',
    one(async (c, s) => {
      const ids = [s.id, ...Object.values(s.children || {})];
      for (const id of ids) runner.deleting.add(id);
      try {
        runner.stop(s);
        runner.stopSides(s);
        await runner.live.get(s.id)?.done;
        cleanupCheckpoints(workdir(s), s.id);
        for (const cid of Object.values(s.children || {})) {
          await runner.live.get(cid)?.done;
          if (store.get(cid)) (store.delete(cid), app.broadcast('removed', { id: cid }));
        }
        // Its worktree goes with it; the branch only if it holds nothing beyond its base.
        for (const x of [s, ...(s.also || [])]) if (x.worktree) await removeWorktree(x.worktree, { force: true, branch: s.delegated ? 'force' : true }).catch(() => {}); // a delegate's branch only held the lead's work
        app.terms.close(s.id);
        app.shells?.close(s.id);
        store.delete(s.id);
        app.overlaps?.dropped(s);
        app.broadcast('removed', { id: s.id });
      } finally {
        for (const id of ids) runner.deleting.delete(id);
      }
      c.send(200, { ok: true });
    }),
  );

  // Long-poll until the session needs the user (finished, or asking). ?timeout=seconds.
  r.route(
    'GET',
    '/sessions/:id/wait',
    one(async (c, s) => {
      const timeout = Math.min(Math.max(Number(c.query.get('timeout')) || 60, 0), MAX_WAIT_S) * 1000;
      const end = Date.now() + timeout;
      let gone = false;
      c.req.on('close', () => (gone = true));
      while (!gone && store.get(s.id) && !settled(s) && Date.now() < end) await new Promise((res) => setTimeout(res, 200));
      if (!store.get(s.id)) return c.send(404, { error: 'session was deleted' });
      c.send(200, { ...summarize(s, store), timedOut: !settled(s) });
    }),
  );

  // The latest (or ?turn=<id|index>) presentation, as blocks and as markdown.
  r.route(
    'GET',
    '/sessions/:id/presentation',
    one((c, s) => {
      const q = c.query.get('turn');
      const turn = q === null ? s.turns.at(-1) : s.turns.find((t) => t.id === q) || s.turns.at(Number(q));
      if (!turn) return c.send(404, { error: 'no such turn' });
      const latest = turn === s.turns.at(-1);
      const markdown = latest ? sessionToMarkdown(s) : blocksToMarkdown(turn.presentation?.blocks, turn);
      if (c.query.get('format') === 'markdown') {
        c.res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        return c.res.end(markdown);
      }
      c.send(200, {
        sessionId: s.id,
        turnId: turn.id,
        turnIndex: s.turns.indexOf(turn),
        state: s.state,
        status: turn.status,
        prompt: turn.prompt,
        blocks: turn.presentation?.blocks || [],
        notes: turn.presentation?.notes,
        fallback: !!turn.presentation?.fallback,
        checkpoint: turn.checkpoint ? { commit: turn.checkpoint.commit, head: turn.checkpoint.head, branch: turn.checkpoint.branch, dirty: turn.checkpoint.dirty, at: turn.checkpoint.at } : null,
        rolledBackAt: turn.rolledBackAt || null,
        changes: turn.changes.map((x) => ({ file: x.file, op: x.op, edits: x.edits.length, reverted: !!x.reverted })),
        stats: turn.stats,
        ask: latest ? s.ask || null : null,
        markdown,
      });
    }),
  );

  r.route(
    'POST',
    '/sessions/:id/reply',
    one(async (c, s) => {
      const { text, attachments, queue, mode, agent, model, effort, account, machine, subagents, preset, confirmLimit } = await c.body();
      if (!text?.trim()) return c.send(400, { error: 'text required' });
      notTour(s, 'follow up');
      if (s.kind === 'reminder') return c.send(409, { error: 'A reminder has no agent to follow up with. Start a new task instead.' });
      // Two agents on one conversation would trample each other. A terminal session's follow-up is
      // typed into its terminal (services/tui.js).
      if (app.terms.get(s.id)?.code === null && !s.tui && btwQuestion(text) === null) return c.send(409, { error: 'This task is open in a terminal. Carry on there, or end the terminal first.' });
      if (mode !== undefined && !MODES.has(mode)) return c.send(400, { error: 'mode must be plan, edits or auto.' });
      // "@Ada what do you make of this?": Ada answers on the task, under the message; the task's
      // own agent isn't interrupted. Members named further in join its team for this follow-up on.
      const t = btwQuestion(text) === null && !machine ? tagged(text.trim()) : { all: [], lead: [] };
      if (t.lead.length) {
        if (!t.rest) throw bad(`Tell ${t.lead.map((m) => m.name).join(' and ')} what to do after the name.`);
        const asked = [];
        for (const m of t.lead) asked.push((await app.crew.ask(m, s, t.rest, Array.isArray(attachments) ? attachments : [], others(t))).entry);
        return c.send(200, { crew: asked });
      }
      // subagents / preset: give the lead a team (or another one, [] for none) from this follow-up on.
      let team = subagents !== undefined || preset !== undefined ? followUpTeam(s, { subagents, preset }) : undefined;
      if (t.all.length && !s.parentId) {
        const have = team || s.subagents || [];
        const more = asDelegates(t.all, have);
        if (more.length) team = normalizeTeam([...have, ...more], adapters);
      }
      // machine: carry the task on on a machine instead (services/move.js). '' is here, where it is.
      // A /btw side question never moves it.
      if (typeof machine === 'string' && machine && btwQuestion(text) === null) return c.send(200, await app.mover.move(s.id, machine, { text: text.trim(), attachments, mode, agent, model, effort, team }));
      // agent / model / effort / account: run this follow-up (and the ones after it) on another harness, model or account.
      const run = agent !== undefined || model !== undefined || effort !== undefined || account !== undefined ? await followUpRun(s, { agent, model, effort, account }) : undefined;
      c.send(200, await launcher.replyTo(s, text.trim(), app.uploads.resolve(attachments), queue, mode, run, team, { confirm: confirmLimit === true }));
    }),
  );

  // Fork: a new task that carries on from one of this one's turns (services/fork.js); this one stays.
  r.route(
    'POST',
    '/sessions/:id/fork',
    one(async (c, s) => {
      const { prompt, turnId, agent, model, effort, mode, attachments } = await c.body();
      if (mode !== undefined && !MODES.has(mode)) return c.send(400, { error: 'mode must be plan, edits or auto.' });
      c.send(201, await app.forker.fork(s, { prompt, turnId, agent, model, effort, mode, attachments }));
    }),
  );

  // Share: a link on your wisp Grid that opens the task in a browser (optionally behind a passkey)
  // and imports it into someone else's wisp (services/share.js). GET: what it would carry.
  r.route('GET', '/sessions/:id/share', one(async (c, s) => c.send(200, await app.sharer.preview(s))));
  r.route(
    'POST',
    '/sessions/:id/share',
    one(async (c, s) => {
      const { passkey, work, account } = await c.body();
      c.send(200, await app.sharer.share(s, { passkey: passkey ?? '', work: work !== false, account }));
    }),
  );
  r.route('DELETE', '/sessions/:id/share', one(async (c, s) => c.send(200, await app.sharer.unshare(s))));
  // A pasted share link: the card (peek), then the task carried on here (import).
  r.route('POST', '/shares/peek', async (c) => {
    const { url, passkey } = await c.body();
    c.send(200, await app.sharer.peek(url, { passkey: typeof passkey === 'string' ? passkey : '' }));
  });
  r.route('POST', '/shares/import', async (c) => {
    const { url, passkey, prompt, mode, connectors, crew, agent, model, effort } = await c.body();
    if (mode !== undefined && !MODES.has(mode)) return c.send(400, { error: 'mode must be plan, edits or auto.' });
    const out = await app.sharer.importShare(url, { passkey: typeof passkey === 'string' ? passkey : '', prompt: typeof prompt === 'string' ? prompt : '', mode, connectors: connectors !== false, crew: crew !== false, run: typeof agent === 'string' && agent ? { agent, model: typeof model === 'string' ? model : '', effort: typeof effort === 'string' ? effort : '' } : null });
    c.send(201, { ...summarize(out.session, store), notes: out.notes, connectorsAdded: out.connectors, crewAdded: out.crew });
  });

  // Pack the task's work to move it to another place (services/move.js): bundles, as uploads.
  r.route(
    'POST',
    '/sessions/:id/pack',
    one(async (c, s) => c.send(200, await app.mover.pack(s))),
    { doc: false },
  );

  // Delegates on other machines (services/relay.js). On the lead's wisp, the relay picks up a
  // child's delegation, reports its progress and lands its result; where the delegate ran, it
  // collects what the run changed.
  r.route(
    'POST',
    '/sessions/:id/relay',
    one(async (c, s) => c.send(200, await app.relay.op(s, await c.body()))),
    { doc: false },
  );
  r.route(
    'GET',
    '/sessions/:id/patch',
    one(async (c, s) => c.send(200, { patch: await app.relay.patchOf(s) })),
    { doc: false },
  );

  // The task's goal (server/goal.js): PUT { text, max } sets or replaces it (an idle task goes after
  // it at once), PATCH { action: 'pause' | 'resume' }, DELETE drops it.
  r.route(
    'PUT',
    '/sessions/:id/goal',
    one(async (c, s) => {
      const { text, max } = await c.body();
      notTour(s, 'set a goal');
      for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
      c.send(200, { goal: goalView(app.goals.set(s, { text, max })) });
    }),
  );
  r.route(
    'PATCH',
    '/sessions/:id/goal',
    one(async (c, s) => {
      const { action } = await c.body();
      if (action === 'pause') return c.send(200, { goal: goalView(app.goals.pause(s)) });
      if (action === 'resume') return c.send(200, { goal: goalView(app.goals.resume(s)) });
      c.send(400, { error: 'action must be pause or resume.' });
    }),
  );
  r.route(
    'DELETE',
    '/sessions/:id/goal',
    one((c, s) => (app.goals.drop(s) ? c.send(200, { ok: true }) : c.send(404, { error: 'This task has no goal.' }))),
  );

  // A side question (/btw): answered next to the run, which carries on. text may keep its /btw.
  r.route(
    'POST',
    '/sessions/:id/btw',
    one(async (c, s) => {
      const { text, attachments } = await c.body();
      c.send(200, await launcher.askBtw(s, btwQuestion(text) ?? String(text || ''), app.uploads.resolve(attachments)));
    }),
  );
  r.route(
    'DELETE',
    '/sessions/:id/btw',
    one((c, s) => (runner.dropBtw(s, c.query.get('item') || '') ? c.send(200, { ok: true }) : c.send(404, { error: 'No such side question.' }))),
  );

  // Later (server/later.js): follow-ups and reminders scheduled on the task.
  // POST { at | in, text, remind? }; PATCH { item, at | in, text } or { item, now: true } (Send now),
  // item 'reminder' snoozes one that came due; DELETE ?item=.
  r.route(
    'POST',
    '/sessions/:id/later',
    one(async (c, s) => {
      const body = await c.body();
      notTour(s, 'schedule a follow-up');
      c.send(201, app.later.add(s, { ...body, remind: body.remind === true, by: 'user' }));
    }),
  );
  r.route(
    'PATCH',
    '/sessions/:id/later',
    one(async (c, s) => {
      const body = await c.body();
      c.send(200, (await app.later.edit(s, String(body.item || ''), body)) || { ok: true });
    }),
  );
  r.route(
    'DELETE',
    '/sessions/:id/later',
    one((c, s) => (app.later.cancel(s, c.query.get('item') || '') ? c.send(200, { ok: true }) : c.send(404, { error: 'Already sent, or cancelled.' }))),
  );

  // A run held near the limit (server/guard.js): start: now, as if you'd said yes when it was sent;
  // wait: leave it for the reset (out of Needs you); skip: it never runs.
  r.route(
    'POST',
    '/sessions/:id/held',
    one(async (c, s) => {
      const { action } = await c.body();
      const t = s.turns.at(-1);
      if (t?.status !== 'held') return c.send(404, { error: 'Nothing on this task is waiting for the limit.' });
      if (action === 'start') {
        app.guard.confirm({ agent: t.held.agent, account: t.held.account, kind: t.held.kind, origin: s.origin, crew: s.crew, session: s });
        for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
        runner.release(s);
      } else if (action === 'wait') {
        t.held.waiting = true;
        s.state = 'done';
        s.unread = false;
        app.sessionChanged(s);
      } else if (action === 'skip') runner.skipHeld(s);
      else return c.send(400, { error: 'action must be start, wait or skip.' });
      c.send(200, summarize(s, store));
    }),
  );

  r.route(
    'DELETE',
    '/sessions/:id/queue',
    one((c, s) => {
      const ok = runner.unqueue(s, c.query.get('item') || '');
      return ok ? c.send(200, { ok }) : c.send(404, { error: 'Already sent.' });
    }),
  );
  // { item, text }: change a queued follow-up. { order: [ids] }: the order they go out in.
  // { merge: [ids] }: combine them into one. { item, now: true }: send it now, interrupting the run.
  r.route(
    'PATCH',
    '/sessions/:id/queue',
    one(async (c, s) => {
      const { item, text, order, merge, now } = await c.body();
      if (Array.isArray(order)) return runner.reorderQueue(s, order.map(String)) ? c.send(200, { ok: true }) : c.send(404, { error: 'Already sent.' });
      if (Array.isArray(merge)) return runner.mergeQueued(s, merge.map(String)) ? c.send(200, { ok: true }) : c.send(404, { error: 'Pick two or more of your follow-ups still waiting.' });
      if (now === true) {
        notTour(s, 'follow up');
        if (app.terms.get(s.id)?.code === null) return c.send(409, { error: 'This task is open in a terminal. Carry on there, or end the terminal first.' });
        return runner.sendQueued(s, String(item || '')) ? c.send(200, { ok: true }) : c.send(404, { error: 'Already sent.' });
      }
      if (typeof text !== 'string' || !text.trim()) return c.send(400, { error: 'text required: what the follow-up says.' });
      return runner.editQueued(s, String(item || ''), text.trim()) ? c.send(200, { ok: true }) : c.send(404, { error: 'Already sent.' });
    }),
  );

  r.route(
    'POST',
    '/sessions/:id/answer',
    one(async (c, s) => {
      const { text } = await c.body();
      if (!text?.trim()) return c.send(400, { error: 'text required' });
      c.send(200, { ok: runner.answer(s, text.trim()) });
    }),
  );

  // The card under a turn whose permissions blocked something: allow retries it, deny closes it.
  r.route(
    'POST',
    '/sessions/:id/approve',
    one(async (c, s) => {
      const { turnId, allow } = await c.body();
      notTour(s, 'approve');
      await ensureTrees(s);
      c.send(200, runner.approveBlocked(s, { turnId, allow: allow !== false }));
    }),
  );

  // Revert (or re-apply) a single file's edits from a turn, or roll back (or re-apply) the
  // project's working tree to the checkpoint before a turn. Both note it on the turn and tell
  // the cards; Ship it may have something new (or nothing left) to ship.
  const undo = ({ what, busy, apply, label, event, after }) =>
    one(async (c, s) => {
      notTour(s, what);
      if (runner.working(s)) return c.send(409, { error: busy });
      const body = await c.body();
      const turn = turnOf(s, body.turnId);
      if (!turn) return c.send(404, { error: 'no such turn' });
      await ensureWorktree(s.worktree);
      const result = apply(s, turn, body);
      turn.activity.push({ t: Date.now(), kind: 'edit', ...label(result) });
      s.updatedAt = Date.now();
      app.sessionChanged(s);
      app.broadcast('turn', { sessionId: s.id, turnId: turn.id });
      telemetry.track(event, { agent: s.agent, restore: !!body.restore });
      after?.(s, body);
      app.ship.recheck(s);
      c.send(200, { ok: true, turnId: turn.id, ...result });
    });
  r.route(
    'POST',
    '/sessions/:id/revert',
    undo({
      what: 'revert files',
      busy: 'Stop the running turn before reverting files.',
      apply: (s, turn, { file, restore }) => revertFileChange(s, turn, file, { restore: !!restore }),
      label: (x) => ({ label: `${x.reverted ? 'Reverted' : 'Re-applied'} ${x.file}`, file: x.file }),
      event: 'revert_file',
    }),
  );
  r.route(
    'POST',
    '/sessions/:id/rollback',
    undo({
      what: 'roll back turns',
      busy: 'Stop the running turn before rolling back.',
      apply: (s, turn, { restore }) => rollbackToTurn(s, turn, { restore: !!restore }),
      label: (x) => ({ label: x.rolledBack ? 'Restored checkpoint before this turn' : 'Re-applied turn changes' }),
      event: 'rollback_turn',
      after: (s, { restore }) => app.router.signal(s.id, { rolledBack: restore ? null : true }),
    }),
  );

  // Run a command from an actionable presentation block (actions, tests, terminal).
  r.route(
    'POST',
    '/sessions/:id/exec',
    one(async (c, s) => {
      const { command, turnId, key } = await c.body();
      const cmd = String(command || '').trim();
      if (!cmd) return c.send(400, { error: 'command required' });
      const turn = (turnId && s.turns.find((t) => t.id === turnId)) || s.turns.at(-1);
      if (s.agent === 'wisp') {
        return c.send(200, { command: cmd, output: '✓ Tour preview — in a real project, wisp runs this command in your repo folder and streams the exit code and output here.', exitCode: 0, durationMs: 18 });
      }
      await ensureWorktree(s.worktree);
      const out = await execCommand(workdir(s), cmd);
      if (turn) {
        turn.actionRuns ||= {};
        turn.actionRuns[key || cmd] = { ...out, ranAt: Date.now() };
        turn.activity.push({ t: Date.now(), kind: 'run', label: `Ran ${clip(cmd, 60)}`, detail: cmd });
        store.save(s);
        app.broadcast('turn', { sessionId: s.id, turnId: turn.id });
      }
      telemetry.track('exec_action', { agent: s.agent, exitCode: out.exitCode });
      app.ship.recheck(s);
      c.send(200, out);
    }),
  );

  // What an app block saved (wisp.save in web/js/app-doc.js), so it reopens as it was left.
  // Not broadcast: re-rendering the card would reload the app the user is using.
  r.route(
    'POST',
    '/sessions/:id/app-state',
    one(async (c, s) => {
      const { turnId, key, state = null } = await c.body();
      const turn = s.turns.find((t) => t.id === turnId);
      if (!turn) return c.send(404, { error: 'turn not found' });
      if (typeof key !== 'string' || !/^app:\w{1,24}$/.test(key)) return c.send(400, { error: 'key must look like app:0' });
      if (JSON.stringify(state).length > APP_MAX_STATE) return c.send(400, { error: `state is larger than ${APP_MAX_STATE / 1000} KB` });
      turn.appState = { ...turn.appState, [key]: state };
      store.save(s);
      c.send(200, { ok: true });
    }),
  );

  // Watch: the page its agent keeps beside it and where it stands (server/watch.js).
  r.route(
    'GET',
    '/sessions/:id/watch',
    one((c, s) => (s.watch ? c.send(200, watchDoc(s)) : c.send(404, { error: 'nothing to watch on this task' }))),
  );

  // Take over: continue this exact agent session interactively in a terminal. GET: the command.
  // POST stops the run and opens it: in the terminal app from Settings, or in the page (inline:
  // a terminal here that the page streams from /term; always on a cloud computer).
  // A folder wisp made (a no-folder task's scratch folder, a worktree) is one the user never opened
  // the agent in, so its interactive CLI would stop at "Do you trust this folder?" first: wisp
  // answers yes for it. The user's own folders keep the CLI's question.
  // A terminal session (services/tui.js) opens its CLI again the same way, even with no conversation
  // to resume yet. A take over tells the agent to drop the wisp block (TAKEOVER_NOTE).
  const takeover = (fn) =>
    one(async (c, s) => {
      const adapter = adapters[s.agent];
      if (!adapter?.resumeCommand || (!s.agentSessionId && !s.tui)) return c.send(400, { error: 'This session cannot be resumed in a terminal.' });
      const trusted = store.isScratch(s.cwd) || !!s.worktree?.cwd;
      await ensureTrees(s);
      const argv = s.tui ? tuiArgv(app, s).argv : adapter.resumeCommand({ resumeId: s.agentSessionId, model: s.model, effort: s.effort, dirs: alsoDirs(s), cwd: workdir(s), trusted, systemPrompt: TAKEOVER_NOTE });
      if (trusted && !s.tui) adapter.trust?.(workdir(s));
      const command = `cd ${shq(workdir(s))} && ${argv.map(shq).join(' ')}`;
      c.send(200, { command, ...(await fn(s, argv, c)) });
    });
  r.route('GET', '/sessions/:id/takeover', takeover(() => {}));
  r.route(
    'POST',
    '/sessions/:id/takeover',
    takeover(async (s, argv, c) => {
      const body = await c.body();
      const d = store.config.defaults;
      const inline = body.inline === true || !!s.tui || inWisp(d.terminal || defaultTerminal());
      if (inline && !ptySupported()) throw bad('Taking over inside wisp needs macOS or Linux on the computer the task runs on. Pick a terminal app in Settings → General.');
      // Already open in the page: show it again, the agent in it carries on.
      if (inline && app.terms.get(s.id)?.code === null) return { inline };
      if (runner.live.has(s.id)) {
        runner.stop(s);
        await runner.live.get(s.id)?.done;
      }
      if (inline) app.terms.open(s.id, { argv, cwd: workdir(s), cols: body.cols, rows: body.rows });
      else openInTerminal({ cwd: workdir(s), argv, terminal: d.terminal || defaultTerminal(), custom: d.terminalCommand });
      s.takenOverAt = Date.now();
      telemetry.track('takeover', { agent: s.agent, terminal: inline ? 'wisp' : d.terminal || defaultTerminal() });
      store.save(s);
      return { inline };
    }),
  );

  // The terminal a take over opened in the page. GET: its output as server-sent events. POST:
  // { data } typed into it, or { cols, rows } when the page resized it. DELETE: close it.
  r.route('GET', '/sessions/:id/term', one((c, s) => app.terms.attach(s.id, c.req, c.res)));
  r.route(
    'POST',
    '/sessions/:id/term',
    one(async (c, s) => {
      const body = await c.body();
      if (app.terms.get(s.id)?.code !== null) return c.send(404, { error: 'This task has no terminal open.' });
      if (typeof body.data === 'string') app.terms.input(s.id, body.data, body);
      if (body.cols && body.rows) app.terms.resize(s.id, body.cols, body.rows);
      c.send(200, { ok: true });
    }),
  );
  r.route('DELETE', '/sessions/:id/term', one((c, s) => c.send(200, { ok: app.terms.close(s.id) })));

  r.route(
    'POST',
    '/sessions/:id/stop',
    one((c, s) => {
      runner.stop(s);
      c.send(200, { ok: true });
    }),
  );

  // Pictures and videos the agent pointed at (see mediaFile). Videos answer Range requests, so
  // the player can seek (Safari won't play one without them).
  r.route(
    'GET',
    '/sessions/:id/file',
    one((c, s) => {
      const f = mediaFile(s, c.query.get('path'));
      if (!f) return c.send(404, { error: 'not found' });
      sendFile(c.req, c.res, f.path, MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream');
    }),
    { doc: false },
  );

  // Show in folder, for a picture or video in a reply: where the agent saved it, or wisp's copy
  // once that's gone. Only on the computer itself; through a proxy the page copies the path.
  r.route(
    'POST',
    '/sessions/:id/reveal',
    one(async (c, s) => {
      const body = await c.body();
      const asked = typeof body.path === 'string' ? body.path : '';
      const f = mediaFile(s, asked) || docFile(s, asked);
      if (!f) return c.send(404, { error: 'That file is gone.' });
      const file = f.source || f.path;
      if (app.proxy?.via(c.req)) return c.send(409, { error: 'The file is on the computer running wisp.', path: file });
      revealInFolder(file);
      c.send(200, { ok: true, path: file });
    }),
  );
}
