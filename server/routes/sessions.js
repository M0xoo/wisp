// Sessions: list and launch, one session (read, edit, delete), and what can be done to it:
// wait, presentation, reply, queue, answer, revert, rollback, exec, takeover, stop, file.
// Ids of the form <id>@<machine> are passed through to that machine's wisp (proxy.js).

import fs from 'node:fs';
import path from 'node:path';
import { adapters, listAgents } from '../adapters/index.js';
import { cleanupCheckpoints, revertFileChange, rollbackToTurn } from '../checkpoint.js';
import { execCommand } from '../proc.js';
import { ensureWorktree, removeWorktree } from '../git.js';
import { MIME } from '../http/static.js';
import { blocksToMarkdown, sessionToMarkdown } from '../render.js';
import { summarize, workdir } from '../runner.js';
import { normalizeTeam } from '../subagents.js';
import { openInTerminal, shq } from '../terminal.js';
import { bad, clip, expand, MODES } from '../util.js';

export const MAX_WAIT_S = 290; // long-poll cap per request; clients loop (fetch drops headers after 300s)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// A session "needs you" once it stops running: finished, or blocked on ask_user. A finished run
// with follow-ups still queued is about to start the next one, so it doesn't count yet.
const settled = (s) => s.state === 'waiting' || (s.state !== 'running' && !s.queue?.length);

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
  const followUpRun = async (s, { agent, model, effort }) => {
    agent = agent ? String(agent) : s.agent;
    if (agent !== s.agent) {
      if (s.parentId) throw bad('A subagent runs on the harness its lead picked for it.');
      if (!adapters[agent]) throw bad(`Unknown harness: ${agent}`);
      const found = (await listAgents()).find((a) => a.id === agent);
      if (!found?.available) throw bad(`${adapters[agent].name} isn't installed on this computer.`);
    }
    return { agent, ...(model !== undefined && { model: String(model || '') }), ...(effort !== undefined && { effort: String(effort || '') }) };
  };
  const turnOf = (s, turnId) => (turnId ? s.turns.find((t) => t.id === turnId) : s.turns.at(-1));

  r.route('GET', '/sessions', async (c) => {
    const q = Object.fromEntries(c.query);
    const cwd = q.cwd && expand(q.cwd);
    // Subagent sessions belong to their lead; ?children=1 lists them too.
    // Sessions on machines too (the last ones seen, for a machine that's offline).
    const here = store.all().filter((x) => !x.parentId || q.children).map((x) => summarize(x, store));
    let list = [...here, ...(await machines.sessions(q))].sort((a, b) => b.updatedAt - a.updatedAt);
    if (q.state) list = list.filter((x) => q.state.split(',').includes(x.state));
    if (q.agent) list = list.filter((x) => x.agent === q.agent);
    if (q.project) list = list.filter((x) => x.projectId === q.project || x.project === q.project);
    if (cwd) list = list.filter((x) => x.cwd === cwd || x.cwd?.startsWith(cwd + path.sep));
    if (q.archived !== undefined) list = list.filter((x) => x.archived === (q.archived === 'true' || q.archived === '1'));
    if (Number(q.limit) > 0) list = list.slice(0, Number(q.limit));
    c.send(200, list);
  });
  r.route('POST', '/sessions', async (c) => {
    const body = await c.body();
    // A machine's wisp hands on where a recipe, trigger or Telegram launch came from.
    const o = body.origin;
    const origin = o && ['recipe', 'trigger', 'telegram'].includes(o.kind) ? { kind: o.kind, id: String(o.id || ''), name: String(o.name || '') } : null;
    const out = await launcher.launchAny(body, origin);
    c.send(201, out.length > 1 ? { ...out[0], group: out } : out[0]);
  });

  // A lead comes with its subagents' sessions, so its cards can show their reports and diffs.
  r.route(
    'GET',
    '/sessions/:id',
    one((c, s) => {
      app.ship.recheck(s, { lazy: true }); // edits made outside wisp (in an editor) show up too
      c.send(200, s.children ? { ...s, childSessions: Object.fromEntries(Object.values(s.children).map((cid) => [cid, store.get(cid)]).filter(([, x]) => x)) } : s);
    }),
  );
  r.route(
    'PATCH',
    '/sessions/:id',
    one(async (c, s) => {
      const body = await c.body();
      if (typeof body.title === 'string' && body.title.trim()) Object.assign(s, { title: body.title.trim(), titleAuto: false });
      if (body.state === 'done' && s.state !== 'running') s.state = 'done';
      if (body.state === 'review' && s.state === 'done') s.state = 'review';
      if (typeof body.unread === 'boolean') s.unread = body.unread;
      // The team can change between turns; the next turn's lead sees the new roster.
      if (body.subagents !== undefined && !s.parentId) {
        s.subagents = normalizeTeam(body.subagents, adapters);
        s.children ||= {};
      }
      if (body.archived === true && s.state !== 'running' && s.state !== 'waiting') Object.assign(s, { archived: true, unread: false });
      if (body.archived === false) delete s.archived;
      if (s.state === 'done' || s.archived) app.retro.schedule(s, 0); // finished with it: learn now
      // Archived: a clean worktree goes (its branch stays, a follow-up brings it back).
      // discardWorktree: a compare run you didn't keep; its changes go too.
      if (s.worktree && !runner.live.has(s.id) && (s.archived || body.discardWorktree)) await removeWorktree(s.worktree, { force: !!body.discardWorktree, branch: !!body.discardWorktree && !s.pr && 'force' });
      app.sessionChanged(s);
      c.send(200, summarize(s, store));
    }),
  );
  r.route(
    'DELETE',
    '/sessions/:id',
    one(async (c, s) => {
      runner.stop(s);
      await runner.live.get(s.id)?.done;
      cleanupCheckpoints(workdir(s), s.id);
      for (const cid of Object.values(s.children || {})) {
        await runner.live.get(cid)?.done;
        if (store.get(cid)) (store.delete(cid), app.broadcast('removed', { id: cid }));
      }
      // Its worktree goes with it; the branch only if it holds nothing beyond its base.
      if (s.worktree) await removeWorktree(s.worktree, { force: true, branch: true }).catch(() => {});
      store.delete(s.id);
      app.broadcast('removed', { id: s.id });
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
      const { text, attachments, queue, mode, agent, model, effort } = await c.body();
      if (!text?.trim()) return c.send(400, { error: 'text required' });
      notTour(s, 'follow up');
      if (mode !== undefined && !MODES.has(mode)) return c.send(400, { error: 'mode must be plan, edits or auto.' });
      // agent / model / effort: run this follow-up (and the ones after it) on another harness or model.
      const run = agent !== undefined || model !== undefined || effort !== undefined ? await followUpRun(s, { agent, model, effort }) : undefined;
      c.send(200, await launcher.replyTo(s, text.trim(), app.uploads.resolve(attachments), queue, mode, run));
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
      await ensureWorktree(s.worktree);
      c.send(200, runner.approveBlocked(s, { turnId, allow: allow !== false }));
    }),
  );

  // Revert (or re-apply) a single file's edits from a turn, or roll back (or re-apply) the
  // project's working tree to the checkpoint before a turn. Both note it on the turn and tell
  // the cards; Ship it may have something new (or nothing left) to ship.
  const undo = ({ what, busy, apply, label, event, after }) =>
    one(async (c, s) => {
      notTour(s, what);
      if (runner.live.has(s.id)) return c.send(409, { error: busy });
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

  // Take over: continue this exact agent session interactively in a terminal. GET: the command.
  const takeover = (fn) =>
    one(async (c, s) => {
      const adapter = adapters[s.agent];
      if (!adapter?.resumeCommand || !s.agentSessionId) return c.send(400, { error: 'This session cannot be resumed in a terminal.' });
      const argv = adapter.resumeCommand({ resumeId: s.agentSessionId, model: s.model, effort: s.effort });
      await ensureWorktree(s.worktree);
      const command = `cd ${shq(workdir(s))} && ${argv.map(shq).join(' ')}`;
      await fn(s, argv);
      c.send(200, { command });
    });
  r.route('GET', '/sessions/:id/takeover', takeover(() => {}));
  r.route(
    'POST',
    '/sessions/:id/takeover',
    takeover(async (s, argv) => {
      if (runner.live.has(s.id)) {
        runner.stop(s);
        await runner.live.get(s.id)?.done;
      }
      const d = store.config.defaults;
      openInTerminal({ cwd: workdir(s), argv, terminal: d.terminal || 'auto', custom: d.terminalCommand });
      s.takenOverAt = Date.now();
      telemetry.track('takeover', { agent: s.agent, terminal: d.terminal || 'auto' });
      store.save(s);
    }),
  );

  r.route(
    'POST',
    '/sessions/:id/stop',
    one((c, s) => {
      runner.stop(s);
      c.send(200, { ok: true });
    }),
  );

  // Images the agent pointed at (screenshots etc.). Served if inside the session's project,
  // or if the agent named that exact path in an image block (screenshots often land in /tmp).
  r.route(
    'GET',
    '/sessions/:id/file',
    one((c, s) => {
      const dir = workdir(s);
      let p = path.resolve(dir, c.query.get('path') || '');
      const ext = path.extname(p).toLowerCase();
      const images = s.turns.flatMap((t) => (t.presentation?.blocks || []).filter((b) => b?.type === 'image'));
      const at = (v) => typeof v === 'string' && path.resolve(dir, v) === p;
      const named = images.find((b) => at(b.path || b.src));
      // A page rendered before keepImages() rewrote the block still asks for the original path.
      const kept = !named && images.find((b) => at(b.source) && typeof b.path === 'string');
      if (kept) p = path.resolve(dir, kept.path);
      if (!(p.startsWith(dir + path.sep) || named || kept) || !IMAGE_EXT.has(ext) || !fs.existsSync(p)) return c.send(404, { error: 'not found' });
      c.res.writeHead(200, { 'content-type': MIME[ext] });
      fs.createReadStream(p).pipe(c.res);
    }),
    { doc: false },
  );
}
