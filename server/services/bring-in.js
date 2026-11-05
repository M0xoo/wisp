// Bring in: someone leaving another tool keeps their work in progress. A project's Conductor
// worktrees become tasks in place, each on its own path and branch, with its uncommitted changes as
// they are and its Claude chat resuming on the next message.
//
//   find   only `git worktree list` of the one project asked about (never a walk of ~/conductor,
//          never at startup), kept to Conductor's folders and checked to be this repo.
//   take   a task with worktree.foreign set, and one finished turn saying where it came from. No
//          setup, no writes in the folder. head stays null: the first real turn takes a true
//          checkpoint of the work as it stands, so rolling that turn back keeps it.
//   after  wisp never removes one: isForeign() in git.js guards every way out, by the mark and by
//          where the folder is.

import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { conductorWorkspace } from '../conductor.js';
import { git, pathKey, repoRoot, samePath, worktreeSource } from '../git.js';
import { summarize } from '../runner.js';
import { MODES, newId } from '../util.js';

const FROM = { id: 'conductor', name: 'Conductor' };
const GITS_AT_ONCE = 4;
const MAX_SKIPPED = 200; // a project's dismissed folders: the oldest go first

// `git worktree list --porcelain`: blocks of lines, the main checkout first.
function parseWorktrees(out) {
  const list = [];
  let wt = null;
  for (const line of String(out).split('\n')) {
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') list.push((wt = { path: path.resolve(value), branch: '' }));
    else if (!wt) continue;
    else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare' || key === 'detached' || key === 'prunable') wt[key] = true;
  }
  return list;
}

async function eachAtMost(n, list, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Relative in the main checkout, absolute in a linked one.
const commonDir = (dir) => git(dir, ['rev-parse', '--git-common-dir']).then((out) => path.resolve(dir, out), () => null);

// The worktrees of the repo at `dir` that can be brought in. known: folders that are spoken for
// (a task holds them, or the user said Not now). root: the main checkout, for take().
export async function foreignWorktrees(dir, { known = [] } = {}) {
  const none = { from: FROM.name, items: [], detached: 0, root: null };
  const list = parseWorktrees(await git(dir, ['worktree', 'list', '--porcelain']).catch(() => ''));
  const common = list.length && (await commonDir(dir));
  if (!common) return none;
  const root = list[0].path;
  const own = await repoRoot(dir);
  const taken = new Set([...known].map(pathKey));
  const candidates = list.slice(1).filter((w) => !w.bare && !w.prunable && !samePath(w.path, dir) && !samePath(w.path, own || dir) && !taken.has(pathKey(w.path)) && isDir(w.path) && conductorWorkspace(w.path, root));
  const seen = await eachAtMost(GITS_AT_ONCE, candidates, async (w) => {
    // git's own word that it's this repo: the folder may have been replaced since it was listed.
    const theirs = await commonDir(w.path);
    if (!theirs || !samePath(theirs, common)) return null;
    if (w.detached || !w.branch) return { detached: true };
    const status = await git(w.path, ['status', '--porcelain'], { timeout: 30_000 }).catch(() => null);
    if (status === null) return null;
    return { path: w.path, branch: w.branch, name: path.basename(w.path), dirty: status ? status.split('\n').length : 0, chat: !!adapters.claude.latestSession(w.path), from: FROM.id };
  });
  return { from: FROM.name, items: seen.filter((x) => x?.path), detached: seen.filter((x) => x?.detached).length, root };
}

// What the task is called: Conductor renames a branch on the first chat, and the folder keeps its
// city, so the branch says more.
const titleOf = (item) => item.branch.split('/').pop().replace(/[-_]+/g, ' ').trim() || item.name;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createBringIn(app) {
  const { store, runner } = app;

  // One at a time per project: a double click finds the first one's tasks already holding the folders.
  const queues = new Map(); // project id -> the last job queued
  const inTurn = (id, job) => {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(job);
    queues.set(id, next);
    const clear = () => queues.get(id) === next && queues.delete(id);
    next.then(clear, clear);
    return next;
  };

  // Every task counts, archived too: their worktrees stay where they are.
  const held = () => store.all().flatMap((s) => [s, ...(s.also || [])].map((x) => x.worktree?.path).filter(Boolean));

  // Here only: a project on a machine has no folder on this computer, and scratch isn't a repo.
  const offer = async (p) => {
    const dir = store.pathAt(p);
    if (!dir || store.isScratch(dir)) return { from: FROM.name, items: [], detached: 0, root: null };
    return foreignWorktrees(dir, { known: [...held(), ...(p.skipWorktrees || [])] });
  };

  function task(p, item, root, source) {
    const d = store.config.defaults;
    const chat = adapters.claude.latestSession(item.path);
    const agent = chat || !adapters[d.agent] ? 'claude' : d.agent;
    const mode = MODES.has(d.mode) ? d.mode : 'auto';
    const model = d.models?.[agent] || '';
    const effort = d.efforts?.[agent] || '';
    const now = Date.now();
    const said = `Brought in from ${FROM.name}`; // what the card reads: the facts are in the report
    const facts = [`Folder: \`${item.path}\``, `Branch: \`${item.branch}\``, item.dirty ? `${plural(item.dirty, 'uncommitted file')}, as ${item.dirty === 1 ? 'it was' : 'they were'}` : 'No uncommitted files', chat ? 'The Claude chat resumes on your next message' : 'No Claude chat was found, so your next message starts a new one'];
    const s = runner.create({
      prompt: said,
      cwd: store.pathAt(p),
      agent,
      mode,
      model,
      effort,
      title: titleOf(item),
      idle: true, // nothing to run: it waits for your first message
      worktree: {
        path: item.path,
        cwd: item.path,
        branch: item.branch,
        base: source?.base.branch || '',
        baseRef: source?.base.ref || '',
        head: null, // never set: see the top of this file
        remote: source?.base.remote ?? null,
        root,
        createdAt: now,
        foreign: FROM.id,
      },
      history: [
        {
          id: newId(),
          prompt: said,
          by: 'wisp',
          agent,
          model,
          effort,
          mode,
          attachments: [],
          startedAt: now,
          endedAt: now,
          status: 'done',
          checkpoint: null,
          activity: [],
          changes: [],
          presentation: { blocks: [{ type: 'markdown', text: facts.map((x) => `- ${x}`).join('\n') }] },
          stats: null,
        },
      ],
    });
    s.agentSessionId = chat;
    app.sessionChanged(s);
    app.ship?.recheck(s); // its uncommitted files show on the card
    return { s, resumed: !!chat };
  }

  // paths: which to take, all that are offered when left out. Worked out again here: a path that
  // isn't offered now is refused, never trusted, which is also what stops a second click.
  const take = (p, paths) =>
    inTurn(p.id, async () => {
      const { items, root } = await offer(p);
      const byPath = new Map(items.map((x) => [pathKey(x.path), x]));
      const missed = [];
      const wanted = new Set();
      for (const asked of paths ?? items.map((x) => x.path)) {
        const item = asked && byPath.get(pathKey(asked));
        if (item) wanted.add(item);
        else missed.push({ path: asked, why: `Not offered here: it isn't a ${FROM.name} worktree of this project, or a task already has it.` });
      }
      if (!wanted.size) return { tasks: [], missed };
      const source = await worktreeSource(root).catch(() => null); // once: it's a fetch
      const made = [];
      for (const item of wanted) {
        try {
          made.push(task(p, item, root, source));
        } catch (err) {
          missed.push({ path: item.path, why: err.message });
        }
      }
      if (made.length) app.telemetry?.track('worktrees_brought_in', { n: made.length, resumed: made.filter((x) => x.resumed).length });
      return { tasks: made.map(({ s }) => summarize(s, store)), missed };
    });

  // Not now: these folders stop being offered, a worktree made later still is.
  const dismiss = (p) =>
    inTurn(p.id, async () => {
      const { items } = await offer(p);
      if (items.length) {
        p.skipWorktrees = [...(p.skipWorktrees || []), ...items.map((x) => x.path)].slice(-MAX_SKIPPED);
        app.configChanged();
      }
      return { ok: true, skipped: items.length, paths: items.map((x) => x.path) };
    });

  // Not now's Undo: exactly these folders are offered again.
  const undismiss = (p, paths) =>
    inTurn(p.id, async () => {
      const back = new Set(paths.map(pathKey));
      const left = (p.skipWorktrees || []).filter((x) => !back.has(pathKey(x)));
      if (left.length !== (p.skipWorktrees || []).length) {
        p.skipWorktrees = left;
        app.configChanged();
      }
      return { ok: true, skipped: 0, paths: [] };
    });

  return { offer, take, dismiss, undismiss };
}
