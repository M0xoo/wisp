// Old worktrees. Each task gets its own checkout, with its node_modules and build output, and a
// finished task keeps it: left alone they fill the disk (hundreds of folders, gigabytes each).
//
// defaults.worktreeCleanup ('off', or days idle) removes the folder of a task nobody has touched
// for that long, every hour; under LOW_DISK free it goes on to the oldest idle ones. Only what can
// come back goes: the branch stays and a follow-up rebuilds the folder (ensureWorktree). So a task
// that's in use, kept (keepWorktree), parked in For later, on an open PR, or with anything only its
// folder holds is skipped, and Settings → Worktrees lists them for the user to decide.
// Folders no task knows (leftovers) are only ever removed by hand.

import fs from 'node:fs';
import path from 'node:path';
import { folderOnly, isForeign, removeWorktree } from '../git.js';
import { execFile } from '../proc.js';
import { bad } from '../util.js';

export const CLEANUP_DEFAULT = '14';
const DAY = 86_400_000;
const GB = 1024 ** 3;
const SWEEP_MS = 3_600_000;
const FIRST_SWEEP_MS = 120_000;
const FRESH_MS = 60_000; // a look this recent stands; each one runs git in every worktree
const LOOKS = 6; // gits side by side
const LOW_DISK = 10 * GB;
const ENOUGH_DISK = 15 * GB; // a low-disk sweep stops here, so it doesn't run again next hour
const MIN_IDLE = DAY; // the least idle a worktree is, for Clean up now or a low disk to take it

// Bytes each child of dir takes, by its path. Empty where there's no du (Windows): sizes just don't show.
const folderSizes = (dir) =>
  new Promise((resolve) => {
    // Some of it unreadable: du still prints the rest, and fails.
    execFile('du', ['-k', '-d', '1', dir], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => {
      const sizes = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m && m[2] !== dir) sizes.set(m[2], Number(m[1]) * 1024);
      }
      resolve(sizes);
    });
  });

const diskOf = async (dir) => {
  try {
    const st = await fs.promises.statfs(dir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
};

async function pool(items, size, fn) {
  const left = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (left.length) await fn(left.shift());
  }));
}

export function createWorktrees(app) {
  const { store, runner } = app;
  const dir = path.join(store.home, 'worktrees');
  const trees = (s) => [s, ...(s.also || [])].map((x) => x.worktree).filter((wt) => wt && !isForeign(wt));
  let seen = { at: 0, trees: new Map(), sizes: new Map(), leftovers: [], disk: null };
  let scanning = null;
  let cleaning = null; // { done, total } while a clean-up runs
  let queue = [];
  let timers = [];

  const setting = () => store.config.defaults.worktreeCleanup ?? CLEANUP_DEFAULT;
  const idleDays = () => (setting() === 'off' ? null : Number(setting()));

  const look = async () => {
    const [sizes, disk] = await Promise.all([folderSizes(dir), diskOf(dir)]);
    const known = new Set(store.all().flatMap(trees).map((wt) => wt.path));
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    const leftovers = entries.filter((e) => e.isDirectory() && !known.has(path.join(dir, e.name))).map((e) => e.name);
    const found = new Map();
    const read = async (wt) => {
      const stat = await fs.promises.stat(wt.path).catch(() => null);
      if (stat) found.set(wt.path, { only: await folderOnly(wt).catch(() => null), touched: stat.mtimeMs });
    };
    await pool([...store.all().flatMap(trees), ...leftovers.map((name) => ({ path: path.join(dir, name) }))], LOOKS, read);
    seen = { at: Date.now(), trees: found, sizes, leftovers, disk };
  };
  const scan = () => (scanning ||= look().finally(() => (scanning = null)));

  // In use right now, by the task, its lead, a side discussion reading it, or a shell or app in it.
  const busy = (s) => {
    const lead = s.parentId ? store.get(s.parentId) : null;
    const running = (x) => x.state === 'running' || x.state === 'waiting' || !!x.ask || !!x.shipping || !!x.queue?.length || runner.working(x);
    return running(s) || (!!lead && running(lead)) || (s.sides || []).some((id) => runner.live.has(id)) || !!app.shells?.get(s.id) || !!app.terms?.get(s.id) || !!app.runs?.running(s.id);
  };

  // Why a task's worktree stays, or 'idle': it can go. Tree lookups come from the last scan.
  const standing = (s) => {
    if (busy(s)) return 'busy';
    if (s.keepWorktree) return 'kept';
    if (s.forLater) return 'parked';
    if ([s, ...(s.also || [])].some((x) => x.pr?.state === 'OPEN')) return 'pr';
    const looked = trees(s).map((wt) => seen.trees.get(wt.path)).filter(Boolean);
    if (!looked.length) return 'checking';
    if (looked.some((t) => t.only === null)) return 'unreadable';
    return looked.some((t) => t.only > 0) ? 'dirty' : 'idle';
  };

  // Rows: a task with at least one folder on disk.
  const held = (s) => trees(s).filter((wt) => fs.existsSync(wt.path));
  const usedAt = (s) => Math.max(s.updatedAt || 0, s.createdAt || 0, ...trees(s).map((wt) => seen.trees.get(wt.path)?.touched || 0));
  const sizeOf = (s) => {
    const list = held(s).map((wt) => seen.sizes.get(wt.path));
    return list.some((n) => n === undefined) ? null : list.reduce((a, b) => a + b, 0);
  };
  const tasks = () => store.all().filter((s) => held(s).length);
  // Upgraded into the default: the clock starts then, so no folder goes the day it arrives.
  const clockFrom = () => (store.config.defaults.worktreeCleanup === undefined ? store.config.worktreeCleanupFrom || 0 : 0);
  const cleanAt = (s) => {
    const days = idleDays();
    return days === null ? null : Math.max(usedAt(s), clockFrom()) + days * DAY;
  };

  function view({ now = Date.now() } = {}) {
    if (now - seen.at > FRESH_MS) scan().catch(() => {});
    const items = tasks().map((s) => {
      const status = standing(s);
      const only = trees(s).reduce((n, wt) => n + (seen.trees.get(wt.path)?.only || 0), 0);
      return {
        id: s.id,
        title: s.title,
        project: store.projectFor?.(s.cwd)?.name || path.basename(s.cwd || ''),
        branch: s.worktree?.branch || trees(s)[0]?.branch || '',
        status,
        only,
        size: sizeOf(s),
        usedAt: usedAt(s),
        cleanAt: status === 'idle' ? cleanAt(s) : null,
      };
    });
    const leftovers = seen.leftovers.filter((name) => fs.existsSync(path.join(dir, name))).map((name) => {
      const p = path.join(dir, name);
      return { name, size: seen.sizes.get(p) ?? null, only: seen.trees.get(p)?.only ?? null, usedAt: seen.trees.get(p)?.touched || 0 };
    });
    const sized = [...items, ...leftovers].filter((x) => x.size !== null);
    return {
      cleanup: setting(),
      items,
      leftovers,
      size: sized.length ? sized.reduce((a, x) => a + x.size, 0) : null,
      disk: seen.disk,
      ready: items.filter((x) => x.status === 'idle' && now - x.usedAt >= MIN_IDLE).length,
      looking: !seen.at || !!scanning,
      cleaning,
      last: store.config.worktreeCleaned || null,
    };
  }

  async function work(auto) {
    if (cleaning) return;
    let count = 0;
    let freed = 0;
    cleaning = { done: 0, total: queue.length };
    while (queue.length) {
      const { s, name, force } = queue.shift();
      if (name) {
        const p = path.join(dir, name);
        const size = seen.sizes.get(p) || 0;
        const r = await removeWorktree(leftover(p), { force: true }).catch(() => null);
        if (r?.removed) (count++, (freed += size), seen.sizes.delete(p));
      } else if (store.get(s.id) === s) {
        const size = sizeOf(s) || 0;
        let gone = 0;
        for (const wt of held(s)) {
          const r = await removeWorktree(wt, { force, strict: !force, still: () => !busy(s) }).catch(() => null);
          if (r?.removed) (gone++, seen.sizes.delete(wt.path), seen.trees.delete(wt.path));
        }
        if (gone) (count++, (freed += size));
      }
      cleaning.done++;
    }
    cleaning = null;
    seen.disk = (await diskOf(dir)) || seen.disk;
    if (count) {
      store.config.worktreeCleaned = { at: Date.now(), count, freed, auto };
      store.saveConfig();
      console.log(`wisp: removed ${count} worktree${count === 1 ? '' : 's'}${auto ? ' (cleanup)' : ''}`);
    }
  }

  // A folder no task knows: git says which repo it belongs to. Without one, only the folder goes.
  const leftover = (p) => {
    let root = dir;
    try {
      const m = /^gitdir: (.+?)[/\\]\.git[/\\]worktrees[/\\]/m.exec(fs.readFileSync(path.join(p, '.git'), 'utf8'));
      if (m && fs.existsSync(m[1])) root = m[1];
    } catch {}
    return { path: p, root };
  };

  // By hand: ids (or none: every worktree that's idle), leftovers (folder names), force for one with
  // uncommitted work. Runs in the background: view() shows `cleaning`. { queued, skipped: [ids] }.
  async function clean({ ids, leftovers = [], force = false } = {}, { now = Date.now() } = {}) {
    if ((ids !== undefined && !Array.isArray(ids)) || !Array.isArray(leftovers)) throw bad('ids and leftovers must be lists', 400);
    if (!seen.at) await scan(); // what it finds stale, the removal reads again
    const skipped = [];
    const jobs = [];
    const picked = ids ? ids.map((id) => store.get(String(id))).filter(Boolean) : leftovers.length ? [] : tasks().filter((s) => standing(s) === 'idle' && now - usedAt(s) >= MIN_IDLE);
    for (const s of picked) {
      const status = standing(s);
      if (status === 'busy' || status === 'checking' || (['dirty', 'unreadable'].includes(status) && !force)) skipped.push(s.id);
      else jobs.push({ s, force: !!force });
    }
    for (const name of leftovers.map(String)) {
      if (path.basename(name) !== name || name === '..' || !seen.leftovers.includes(name)) throw bad(`Not a leftover worktree: ${name}`, 400);
      jobs.push({ name });
    }
    if (ids && !jobs.length && skipped.length) throw bad('That worktree is in use or holds uncommitted work.', 409);
    queue.push(...jobs);
    if (cleaning) cleaning.total += jobs.length;
    else if (jobs.length) work(false).catch((err) => console.warn(`wisp: worktrees: ${err.message}`));
    return { queued: jobs.length, skipped };
  }

  // The hourly look. Awaited in tests.
  async function sweep({ now = Date.now(), low = LOW_DISK, enough = ENOUGH_DISK } = {}) {
    const days = idleDays();
    if (days === null || cleaning) return;
    await scan();
    const idle = tasks().filter((s) => standing(s) === 'idle').sort((a, b) => usedAt(a) - usedAt(b));
    const due = idle.filter((s) => now >= cleanAt(s));
    const jobs = new Set(due);
    // A disk running out doesn't wait for the days: the oldest go until there's room again.
    if (seen.disk && seen.disk.free < low) {
      let free = seen.disk.free + due.reduce((n, s) => n + (sizeOf(s) || 0), 0);
      for (const s of idle) {
        if (free >= enough) break;
        if (jobs.has(s) || now - usedAt(s) < MIN_IDLE) continue;
        jobs.add(s);
        free += sizeOf(s) || 0;
      }
    }
    if (!jobs.size) return;
    queue.push(...[...jobs].map((s) => ({ s, force: false })));
    await work(true);
  }

  function start() {
    if (!store.config.worktreeCleanupFrom) {
      store.config.worktreeCleanupFrom = Date.now();
      store.saveConfig();
    }
    const go = () => sweep().catch((err) => console.warn(`wisp: worktrees: ${err.message}`));
    timers = [setTimeout(go, FIRST_SWEEP_MS), setInterval(go, SWEEP_MS)];
    for (const t of timers) t.unref?.();
  }
  const stop = () => timers.forEach(clearTimeout); // clears either kind

  return { view, clean, sweep, scan, start, stop };
}
