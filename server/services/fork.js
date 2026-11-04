// Forking a task: a new task that carries on from one of its turns, to try another way, while
// the original stays as it is.
//
//   history  the turns up to the one forked from, marked `forked`: every harness hears them first
//            (handoff.js), as it would a moved task's.
//   work     a worktree of its own on a new branch, with the work as it stood after that turn
//            (git.js forkWork): the folder now for the latest turn, else the next turn's checkpoint.
//   link     the fork points at the original (forkedFrom) and the original lists its forks.
//
// A side discussion (/side, server/side.js) is the read-only cousin: a new task with no history and
// no work of its own, that reads the original's folder and hears its latest state every message.

import fs from 'node:fs';
import path from 'node:path';
import { adapters, listAgents } from '../adapters/index.js';
import { ensureWorktree, forkWork } from '../git.js';
import { summarize, workdir } from '../runner.js';
import { bad, MODES, newId } from '../util.js';

export function createFork(app) {
  const { store, runner } = app;

  // The turns the fork starts with, up to and including `upto`: finished ones only, without what
  // belongs to the original (its checkpoints, its subagents' sessions, side questions in flight).
  const history = (turns) =>
    turns.map((t) => {
      const { checkpoint, delegations, ...rest } = t;
      return { ...rest, forked: true, checkpoint: null, btw: (t.btw || []).filter((b) => b.status !== 'running') };
    });

  // A checkpoint keeps new files (untracked) by name only. The ones no later turn edited are still
  // as they were then: copied over from the task's folder.
  function carryUntracked(s, at, to) {
    const from = workdir(s);
    const later = new Set(s.turns.slice(at + 1).flatMap((t) => (t.changes || []).map((c) => path.resolve(from, c.file))));
    for (const f of s.turns[at + 1].checkpoint.untracked || []) {
      const src = path.resolve(from, f);
      if (later.has(src) || !src.startsWith(from + path.sep) || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
      fs.copyFileSync(src, path.join(to, f));
    }
  }

  // body: { prompt, turnId?, agent?, model?, effort?, mode?, attachments? }. Resolves the fork's summary.
  async function fork(s, { prompt, turnId, agent, model, effort, mode, attachments = [] } = {}) {
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to fork it.');
    if (s.parentId || s.delegated) throw bad('A subagent’s run can’t be forked: fork its lead’s task.');
    if (s.sideOf) throw bad('A side discussion has no work of its own to fork: fork its main task.', 409);
    if (s.kind) throw bad(s.kind === 'spell' ? 'A spell can’t be forked: cast another one.' : s.kind === 'pane' ? 'A pane task can’t be forked: ask for another one.' : 'Only a task with an agent can be forked.');
    prompt = String(prompt || '').trim();
    if (!prompt) throw bad('Say what the fork should do.');
    const at = turnId ? s.turns.findIndex((t) => t.id === turnId) : s.turns.findLastIndex((t) => t.status !== 'running');
    if (at < 0) throw bad(turnId ? 'No such turn in this task.' : 'Nothing to fork yet: wait for the first turn to finish.', turnId ? 404 : 409);
    if (s.turns[at].status === 'running') throw bad('That turn is still running: fork it once it has finished.', 409);
    // The work after that turn: what the next turn found when it started (a running one's too),
    // else the folder as it is now.
    const next = s.turns[at + 1];
    const latest = !next;
    if (next && !next.checkpoint?.head) throw bad('wisp has no snapshot of the work at that turn, so it can only fork from the latest one.', 409);

    const run = { agent: agent || s.agent, model: model ?? (agent && agent !== s.agent ? '' : s.model || ''), effort: effort ?? (agent && agent !== s.agent ? '' : s.effort || '') };
    if (!adapters[run.agent]) throw bad(`unknown agent: ${run.agent}`);
    if (!(await listAgents()).some((a) => a.id === run.agent && a.available)) throw bad(`${adapters[run.agent].name} isn’t installed here. Pick another harness for the fork.`);

    const id = newId();
    const title = prompt;
    const scratch = store.isScratch(s.cwd);
    let cwd = s.cwd;
    let worktree = null;
    let also = [];
    if (scratch) {
      // A folder-less task's files are copied: the fork gets a scratch folder of its own.
      cwd = store.scratchDir(id);
      if (fs.existsSync(s.cwd)) fs.cpSync(s.cwd, cwd, { recursive: true });
    } else {
      worktree = await forkWork({ dir: workdir(s), wt: s.worktree, at: latest ? null : next.checkpoint, home: store.home, id, title });
      if (!worktree) throw bad('Only a task in a git repo with commits (or without a folder) can be forked: its work needs a worktree to be copied into.', 409);
      if (!latest) carryUntracked(s, at, worktree.cwd);
      // The other folders have no checkpoints of their own: they're forked as they are now.
      also = await Promise.all(
        (s.also || []).map(async (a) => {
          const wt = await forkWork({ dir: a.worktree?.cwd || a.cwd, wt: a.worktree, home: store.home, id, title }).catch((err) => console.warn(`wisp: no fork of ${a.cwd}: ${err.message}`));
          return { cwd: a.cwd, ...(wt && { worktree: wt }) };
        }),
      );
    }
    const n = at + 1;
    const session = runner.create({
      id,
      prompt,
      cwd,
      also,
      ...run,
      mode: MODES.has(mode) ? mode : s.mode,
      attachments: app.uploads.resolve(attachments),
      worktree,
      subagents: s.subagents || [],
      history: history(s.turns.slice(0, n)),
      forkedFrom: { id: s.id, title: s.title, turn: n, of: s.turns.length },
    });
    s.forks = [...(s.forks || []), id];
    store.save(s);
    app.sessionChanged(s);
    app.telemetry?.track('fork_task', { agent: run.agent, switched: run.agent !== s.agent, latest });
    return summarize(session, store);
  }

  // /side: a side discussion about s. body: { prompt, agent?, model?, effort?, attachments? }.
  async function side(s, { prompt, agent, model, effort, attachments = [] } = {}) {
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to talk it over.');
    if (s.parentId || s.delegated) throw bad('A subagent’s run has no side discussions: start one on its lead’s task.');
    if (s.sideOf) throw bad('This is a side discussion already: carry on here, or start another from the main task.', 409);
    if (s.kind === 'reminder') throw bad('A reminder has no work to talk over.');
    prompt = String(prompt || '').trim();
    if (!prompt) throw bad('Say what to talk over after /side, like “/side why did it pick sqlite?”');
    const run = { agent: agent || s.agent, model: model ?? (agent && agent !== s.agent ? '' : s.model || ''), effort: effort ?? (agent && agent !== s.agent ? '' : s.effort || '') };
    if (!adapters[run.agent]) throw bad(`unknown agent: ${run.agent}`);
    if (!(await listAgents()).some((a) => a.id === run.agent && a.available)) throw bad(`${adapters[run.agent].name} isn’t installed here. Pick another harness for the side discussion.`);
    // It reads the work where it is: an archived task's clean worktree comes back first.
    for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
    const session = runner.create({
      prompt,
      cwd: s.cwd,
      ...run,
      mode: runner.sideMode(run.agent),
      attachments: app.uploads.resolve(attachments),
      sideOf: { id: s.id, title: s.title, cwd: workdir(s) },
    });
    s.sides = [...(s.sides || []), session.id];
    store.save(s);
    app.sessionChanged(s);
    app.telemetry?.track('side_task', { agent: run.agent, running: runner.live.has(s.id) });
    return summarize(session, store);
  }

  // Before a side discussion's turn: the main task's folder as it is now (a worktree comes back if
  // it was archived away, a moved task's new place), or a clear refusal once it's gone.
  async function sideFolder(side) {
    const main = store.get(side.sideOf.id);
    if (main) {
      for (const x of [main, ...(main.also || [])]) await ensureWorktree(x.worktree);
      side.sideOf.cwd = workdir(main);
      side.sideOf.title = main.title;
    }
    if (!fs.existsSync(side.sideOf.cwd)) throw bad('The main task’s folder is gone, so there’s nothing left to read. Start a new side discussion from a task that still has its work.', 409);
  }

  return { fork, side, sideFolder };
}
