// Done asks about the worktree (design/worktrees-on-done.md). A task marked done, and what ran
// under it (its other folders, its subagents' and delegated crew jobs' own worktrees, the compare
// runs beside it that are done too), may hold folders on disk: gigabytes each, left behind.
//
// From the page, Done lists them (list) and the user picks (apply): clean ones go on Remove, one
// with work only it holds goes only when ticked, Keep pins them (keepWorktree). Done from anywhere
// else (the phone's notification, a channel, wisp_task, Ship it, a crew job ending) asks nobody:
// tidy() removes only what's clean and fully on its branch (folderOnly === 0) with no open PR, and
// leaves the rest to the hourly cleanup (services/worktrees.js). The branch always stays: a
// follow-up rebuilds the folder (ensureWorktree).

import fs from 'node:fs';
import { folderOnly, isForeign, removeWorktree, worktreeStatus } from '../git.js';
import { execFile } from '../proc.js';
import { bad } from '../util.js';

export const ON_DONE = ['ask', 'remove', 'keep'];
const DEPTH = 4; // a lead's subagent's delegate's …: far enough, and no loop

// Bytes under one folder, or null (no du: Windows; or too slow to wait for).
const sizeOf = (dir) =>
  new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      const m = /^(\d+)\t/.exec(String(stdout || ''));
      resolve(m ? Number(m[1]) * 1024 : null);
    });
  });

export function createDoneFolders(app) {
  const { store, runner } = app;
  const setting = () => (ON_DONE.includes(store.config.defaults?.worktreeOnDone) ? store.config.defaults.worktreeOnDone : 'ask');

  // In use right now: removing its folder would pull it out from under a run, a shell or an app.
  const busy = (x) =>
    x.state === 'running' || x.state === 'waiting' || !!x.ask || !!x.shipping || !!x.queue?.length || !!runner.working?.(x) || !!runner.live?.has(x.id) ||
    (x.sides || []).some((id) => runner.live?.has(id)) || !!app.shells?.get?.(x.id) || !!app.terms?.get?.(x.id) || !!app.runs?.running?.(x.id);

  // The task and every task under it, each once.
  function under(s, seen = new Set(), depth = 0) {
    if (!s || seen.has(s.id) || depth > DEPTH) return [];
    seen.add(s.id);
    const all = store.all();
    const ids = [
      ...Object.values(s.children || {}),
      ...(s.turns || []).flatMap((t) => (t.delegations || []).map((d) => d.sessionId)),
    ];
    const kids = [
      ...ids.map((id) => store.get(String(id || ''))),
      ...all.filter((x) => x.parentId === s.id),
      // Compare runs: the ones marked done with it (Mark every run done), not one still in review.
      ...(s.groupId ? all.filter((x) => x.groupId === s.groupId && x.id !== s.id && x.state === 'done') : []),
    ];
    return [s, ...kids.filter(Boolean).flatMap((x) => under(x, seen, depth + 1))];
  }

  // Each folder on disk: who holds it, and its PR. A subagent working in its lead's folder is the lead's.
  function folders(s) {
    const out = [];
    const paths = new Set();
    for (const x of under(s)) {
      const prOf = (wt, at) => at?.pr || (at === x && (x.prs || []).find((y) => y.pr?.branch && y.pr.branch === wt.branch)?.pr) || null;
      for (const at of [x, ...(x.also || [])]) {
        const wt = at.worktree;
        if (!wt?.path || isForeign(wt) || paths.has(wt.path) || !fs.existsSync(wt.path)) continue;
        paths.add(wt.path);
        out.push({ x, wt, pr: prOf(wt, at) });
      }
    }
    return out;
  }

  // What the dialog shows: one row a folder, in use ones left out (nothing to decide on them now).
  // sizes: false answers at once (du over a big node_modules takes seconds); the page asks again for them.
  async function list(s, { sizes = true } = {}) {
    const rows = await Promise.all(
      folders(s)
        .filter((f) => !busy(f.x))
        .map(async ({ x, wt, pr }) => {
          const [only, st, size] = await Promise.all([folderOnly(wt).catch(() => null), worktreeStatus(wt).catch(() => null), sizes ? sizeOf(wt.path) : null]);
          return {
            path: wt.path,
            task: x.id,
            title: x.title || '',
            own: x.id === s.id,
            branch: wt.branch || '',
            size,
            // Lost with the folder: uncommitted files, plus one when HEAD left the branch. null: git can't tell.
            only,
            uncommitted: st?.dirty ?? null,
            unpushed: st?.unpushed ?? 0,
            pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
            kept: !!x.keepWorktree,
          };
        }),
    );
    return { folders: rows, onDone: setting() };
  }

  // The user's answer: remove (paths), force (of those, the ones with work to drop), keep (paths).
  // Only folders list() would show. A removal that fails keeps the folder (keepWorktree) and says why.
  async function apply(s, { remove = [], force = [], keep = [] } = {}) {
    if (![remove, force, keep].every(Array.isArray)) throw bad('remove, force and keep must be lists of paths', 400);
    const mine = new Map(folders(s).map((f) => [f.wt.path, f]));
    for (const p of [...remove, ...keep]) if (!mine.has(String(p))) throw bad(`Not a folder of this task: ${p}`, 400);
    const forced = new Set(force.map(String));
    const out = { removed: [], kept: [], failed: [] };
    const pin = (x) => {
      if (x.keepWorktree) return;
      x.keepWorktree = true;
      app.sessionChanged?.(x);
    };
    for (const p of keep.map(String)) (pin(mine.get(p).x), out.kept.push(p));
    for (const p of remove.map(String)) {
      const { x, wt } = mine.get(p);
      const why = busy(x) ? 'It’s in use.' : null;
      const r = why ? null : await removeWorktree(wt, { strict: !forced.has(p), force: forced.has(p), still: () => !busy(x) }).catch((err) => ({ error: err.message }));
      if (r?.removed) {
        out.removed.push(p);
        if (x.keepWorktree) (delete x.keepWorktree, app.sessionChanged?.(x));
        continue;
      }
      pin(x);
      out.failed.push({ path: p, error: why || r?.error || (r?.dirty ? `It holds work of its own (${r.dirty} change${r.dirty === 1 ? '' : 's'}): tick it to remove it anyway.` : 'It couldn’t be removed.') });
    }
    if (out.removed.length) app.sessionChanged?.(s);
    return out;
  }

  // Done with nobody to ask: only what nothing would be lost from, and nothing on an open PR.
  // Kept tasks and the Keep setting are left alone. Resolves to the paths removed.
  async function tidy(s) {
    if (setting() === 'keep') return [];
    const gone = [];
    for (const { x, wt, pr } of folders(s)) {
      if (busy(x) || x.keepWorktree || x.forLater || pr?.state === 'OPEN') continue;
      const only = await folderOnly(wt).catch(() => null);
      if (only !== 0) continue;
      const r = await removeWorktree(wt, { strict: true, still: () => !busy(x) }).catch(() => null);
      if (r?.removed) gone.push(wt.path);
    }
    if (gone.length) app.sessionChanged?.(s);
    return gone;
  }

  return { list, apply, tidy, under, setting };
}
