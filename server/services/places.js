// Places: this computer and the machines. A project is one repo that every place can run, so a
// task launched on a machine that has no checkout of it yet gets one first: a clone of the same
// repo that's already there (registered or in the usual folders), else a fresh clone of its
// origin. The checkout is remembered as the project's copy on that machine (store.setCopy).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneRepo, git, repoOf, sameRepo } from '../git.js';
import { HERE } from '../store.js';
import { bad, expand } from '../util.js';

const CLONE_TIMEOUT_MS = 10 * 60_000;

// Where people keep their repos, for one-click "add project".
export const REPO_ROOTS = ['code', 'Code', 'dev', 'Developer', 'projects', 'Projects', 'src', 'repos', 'work', 'git', 'GitHub', 'Documents', 'Downloads', 'Desktop'];

// Where a pasted repo URL is cloned: defaults.cloneDir, else the first usual repo folder that
// exists (not Documents/Downloads/Desktop), else ~/code.
export function cloneRoot(config) {
  if (config.defaults?.cloneDir) return expand(config.defaults.cloneDir);
  const dir = REPO_ROOTS.slice(0, -3)
    .map((r) => path.join(os.homedir(), r))
    .find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  return dir || path.join(os.homedir(), 'code');
}

// Git repos up to two levels under the usual folders, newest first, skipping known ones.
export function discoverRepos(known = new Set()) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= 60) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      if (!known.has(dir)) found.push({ path: dir, name: path.basename(dir), mtime: fs.statSync(dir).mtimeMs });
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth - 1);
  };
  for (const r of REPO_ROOTS) walk(path.join(os.homedir(), r), 2);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 24);
}

export const originAt = (dir) => git(dir, ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => '');

// A checkout of `url` on this computer: a project (or copy) here that is that repo, else one in
// the usual folders, else a fresh clone into the clone folder. Resolves { dir, existed }.
export async function checkout(store, url) {
  const repo = repoOf(url);
  if (!repo) throw bad(`Not a repo URL: ${url}`);
  const mine = store.config.projects.map((p) => [p, store.pathAt(p)]).filter(([, dir]) => dir && fs.existsSync(dir));
  for (const [p, dir] of mine) if (sameRepo(p.repo || (await originAt(dir)), url)) return { dir, existed: true };
  const found = discoverRepos();
  const origins = await Promise.all(found.map((f) => originAt(f.path)));
  const hit = found.find((f, i) => sameRepo(origins[i], url));
  if (hit) return { dir: hit.path, existed: true };
  return cloneRepo(repo, cloneRoot(store.config), { timeout: CLONE_TIMEOUT_MS });
}

export function createPlaces(app) {
  const { store, machines } = app;
  const placeName = (mid) => (mid ? machines.get(mid).name : 'this computer');
  const inflight = new Map(); // `${project}@${place}` -> promise, so two launches clone once

  // The project's origin URL, asked of whichever place has a checkout; kept on the project.
  async function originOf(p) {
    if (p.repo) return p.repo;
    const places = [p.machine || null, ...Object.keys(p.copies || {}).map((k) => (k === HERE ? null : k))];
    for (const mid of places) {
      const dir = store.pathAt(p, mid);
      let url = '';
      if (!mid) url = fs.existsSync(dir) ? await originAt(dir) : '';
      else if (machines.isOnline(mid)) url = (await machines.json(mid, 'GET', `/projects/origin?path=${encodeURIComponent(dir)}`).catch(() => null))?.origin || '';
      if (url) {
        p.repo = url;
        store.saveConfig();
        return url;
      }
    }
    return '';
  }

  async function remoteCheckout(mid, repo, name) {
    try {
      const r = await machines.json(mid, 'POST', '/projects/checkout', { repo, name }, { timeout: CLONE_TIMEOUT_MS });
      return { dir: r.path, existed: !!r.existed };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    // An older wisp there: its POST /projects clones the repo (or reuses a clone of it).
    const r = await machines.json(mid, 'POST', '/projects', { repo }, { timeout: CLONE_TIMEOUT_MS });
    return { dir: r.path, existed: !!r.cloned?.existed };
  }

  // The project's folder on `mid` (null = this computer). fresh: the one wisp knew is gone.
  async function ensureAt(p, mid = null, { fresh = false } = {}) {
    const known = store.pathAt(p, mid);
    if (known && !fresh && (mid || fs.existsSync(known))) return known;
    const key = `${p.id}@${mid || HERE}`;
    if (!inflight.has(key)) {
      const job = (async () => {
        const repo = await originOf(p);
        if (!repo) throw bad(`${p.name} has no git remote (origin) to clone from, so wisp can’t set it up on ${placeName(mid)}. Push it to a remote first, or add its folder there in Projects.`, 409);
        const out = mid ? await remoteCheckout(mid, repo, p.name) : await checkout(store, repo);
        store.setCopy(p, mid, out.dir);
        app.configChanged();
        return out.dir;
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    return inflight.get(key);
  }

  // A task's folder, for running it on `mid`: the same folder in that place's checkout of its
  // project. Folders that are no project's (and ones already on that place) stay as they are.
  async function dirAt(dir, mid = null) {
    if (!dir) return dir;
    if (!mid) dir = expand(dir);
    if (store.projectFor(dir, mid)) return dir;
    for (const from of [null, ...machines.list.map((m) => m.id)]) {
      if (from === (mid || null)) continue;
      const p = store.projectFor(dir, from);
      if (!p) continue;
      // A folder that's here too (the same layout on both computers) is used as it is, unless the
      // project already has its own checkout here.
      if (!mid && fs.existsSync(dir) && !store.pathAt(p)) return dir;
      const rest = dir.slice(store.pathAt(p, from).length).split(/[\\/]/).filter(Boolean);
      const there = await ensureAt(p, mid);
      return rest.length ? (mid ? path.posix : path).join(there, ...rest) : there;
    }
    return dir;
  }

  // A launch body with its folders (cwd, also) moved to `mid`.
  async function placeBody(body, mid = null) {
    if (body.scratch === true) return body;
    const out = { ...body };
    if (body.cwd) out.cwd = await dirAt(String(body.cwd), mid);
    if (Array.isArray(body.also)) out.also = await Promise.all(body.also.map((x) => (typeof x === 'string' ? dirAt(x, mid) : x?.cwd ? dirAt(String(x.cwd), mid) : x)));
    return out;
  }

  return { originOf, ensureAt, dirAt, placeBody, placeName };
}
