// Active tasks in the same repo that change the same files. Each gets `overlaps`, so its card can
// warn before both are shipped or merged: [{ id, title, files, more, conflicts }], where conflicts
// lists the files a merge of the two would leave conflicted ([] when they'd merge cleanly, null when
// git can't tell). Each task's work is read whenever wisp rechecks its worktree (services/ship.js);
// a repo's tasks are then compared, a few seconds at most after the last change there.

import fs from 'node:fs';
import { touchedFiles, clashFiles } from '../git.js';

const COMPARE_MS = 2_000;
const SWEEP_MS = 20_000; // tasks merged, archived or deleted meanwhile drop out of the others' overlaps
const SHOWN = 20; // files listed per overlap; `more` counts the rest

export function createOverlaps(app) {
  const { store } = app;
  const work = new Map(); // id → { key, files, head } from the last look at its worktree
  const clashes = new Map(); // "headA headB" → conflicted files, so an unchanged pair isn't merged again
  const timers = new Map(); // repo key → pending compare
  const looking = new Map(); // repo key → ids to read before comparing

  // Tasks in one repo branched from the same base are compared with each other.
  const keyOf = (s) => (s?.worktree ? `${s.worktree.root}\0${s.worktree.base}` : null);
  // Only tasks still in play: Working, or waiting in Needs you. Done, stopped, archived, merged or
  // closed tasks never warn, and drop out of the others' warnings as soon as they leave.
  const ACTIVE = new Set(['running', 'waiting', 'review']);
  const open = (s) =>
    !!(s?.worktree && !s.parentId && !s.archived && ACTIVE.has(s.state) && s.turns?.at(-1)?.status !== 'stopped' && !['MERGED', 'CLOSED'].includes(s.pr?.state) && fs.existsSync(s.worktree.path));

  const look = async (id) => {
    const s = store.get(id);
    // While its agent works, its last reading stands (none yet: read when the turn ends). wisp
    // never reads a worktree mid-run.
    if (open(s) && app.runner?.live?.has(id)) return;
    const t = open(s) ? await touchedFiles(s.worktree).catch(() => null) : null;
    if (t?.files.length) work.set(id, { key: keyOf(s), files: t.files, head: t.head });
    else work.delete(id);
  };

  const compare = async (key) => {
    const ids0 = store.all().filter((s) => keyOf(s) === key && open(s)).map((s) => s.id);
    // A task alone in its repo can't overlap anything: no git at all.
    if (ids0.length < 2) {
      for (const id of ids0) work.delete(id);
      looking.delete(key);
    } else {
      for (const id of looking.get(key) || []) await look(id);
      looking.delete(key);
      // Tasks of the repo wisp hasn't read yet (after a restart, say) are read once.
      for (const id of ids0) if (!work.has(id)) await look(id);
    }
    const ids = [...work].filter(([id, w]) => w.key === key && open(store.get(id))).map(([id]) => id);
    const found = new Map();
    const add = (id, o) => found.set(id, [...(found.get(id) || []), o]);
    for (const [i, a] of ids.entries()) {
      for (const b of ids.slice(i + 1)) {
        // Runs of one compare are the same task on purpose: they always overlap.
        if (store.get(a).groupId && store.get(a).groupId === store.get(b).groupId) continue;
        const A = work.get(a), B = work.get(b);
        const theirs = new Set(B.files);
        const shared = A.files.filter((f) => theirs.has(f));
        if (!shared.length) continue;
        const pair = [A.head, B.head].sort().join(' ');
        if (!clashes.has(pair)) clashes.set(pair, await clashFiles(store.get(a).worktree.path, A.head, B.head));
        const conflicts = clashes.get(pair);
        const of = (other) => ({ id: other, title: store.get(other)?.title || '', files: shared.slice(0, SHOWN), more: Math.max(0, shared.length - SHOWN), conflicts: conflicts && conflicts.slice(0, SHOWN) });
        add(a, of(b));
        add(b, of(a));
      }
    }
    if (clashes.size > 500) clashes.clear();
    for (const s of store.all()) {
      if (keyOf(s) !== key) continue;
      const next = found.get(s.id);
      if (JSON.stringify(next || null) === JSON.stringify(s.overlaps || null)) continue;
      if (next) s.overlaps = next;
      else delete s.overlaps;
      app.sessionChanged(s);
    }
  };

  const schedule = (key, ms = COMPARE_MS) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        compare(key).catch(() => {});
      }, ms),
    );
  };

  // A task's worktree may have changed: read it again, then compare its repo's tasks.
  const touch = (s) => {
    const key = keyOf(s);
    if (!key || s.parentId) return;
    looking.set(key, new Set([...(looking.get(key) || []), s.id]));
    schedule(key);
  };

  // Any change to a task: one that left play (done, archived, stopped…) stops counting at once,
  // and one back in play (Needs you again) is read and compared again.
  const changed = (s) => {
    const key = keyOf(s);
    if (!key || s.parentId) return;
    if (open(s)) {
      if (!work.has(s.id) && !looking.get(key)?.has(s.id) && !app.runner?.live?.has(s.id)) touch(s);
      return;
    }
    if (!(work.has(s.id) || s.overlaps)) return;
    work.delete(s.id);
    schedule(key, 0);
  };
  // Deleted: gone from the store, so the others are compared again without it.
  const dropped = (s) => {
    work.delete(s.id);
    if (keyOf(s)) schedule(keyOf(s), 0);
  };

  const sweep = setInterval(() => {
    const keys = new Set(store.all().filter((s) => s.overlaps?.length).map(keyOf));
    for (const key of keys) if (key && !timers.has(key)) schedule(key);
  }, SWEEP_MS);
  sweep.unref?.();

  return {
    touch,
    changed,
    dropped,
    stop() {
      clearInterval(sweep);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
