// Persistence: one JSON file per session under ~/.wisp/sessions, plus config.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sameRepo } from './git.js';
import { parsePresentation } from './protocol.js';
import { writeJsonAtomic } from './util.js';

const DEFAULT_CONFIG = {
  projects: [], // [{ id, name, path, color, addedAt, machine?, repo?, copies? }]: see projectFor()
  defaults: { agent: 'auto', mode: 'auto', model: '', effort: '' }, // agent auto: wisp picks harness and model (server/router.js)
  recipes: [], // saved prompts with {params}: server/recipes.js
  triggers: [], // schedules and GitHub watchers: server/triggers.js
  teams: [], // saved subagent presets: server/subagents.js
  crew: [], // long-lived agents with a schedule and memory: server/crew.js
  remote: {}, // phone channels (ntfy, Telegram): server/remote.js
  machines: [], // other computers reached over SSH: server/machines.js
  connectors: [], // MCP servers every task's agent gets: server/connectors.js
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const MAX_KEPT_IMAGE = 25 * 1024 * 1024;
const MAX_KEPT_VIDEO = 200 * 1024 * 1024;
const MAX_KEPT_DOC = 512 * 1024;

// The key for this computer in a project's copies (machine ids are 6 hex characters).
export const HERE = 'here';

export const PROJECT_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];

export class Store {
  constructor(home = process.env.WISP_HOME || path.join(os.homedir(), '.wisp')) {
    this.home = home;
    this.dir = path.join(home, 'sessions');
    this.shots = path.join(home, 'shots');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = new Map();
    this.timers = new Map();
    this.config = this.#loadConfig();

    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        reparse(s);
        this.sessions.set(s.id, s);
        // Backfill: follow-ups queued before items had ids can't be cancelled without one.
        const ids = (s.queue || []).filter((q) => !q.id).map((q) => (q.id = randomUUID().replace(/-/g, '').slice(0, 12)));
        // Backfill: keep screenshots from older turns while their files still exist.
        if ((s.turns || []).map((t) => this.keepImages(s, t)).some(Boolean) || ids.length) this.save(s, { now: true });
      } catch (err) {
        console.warn(`wisp: skipping unreadable session ${f}: ${err.message}`);
      }
    }
  }

  #loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.home, 'config.json'), 'utf8'));
      const cfg = { ...structuredClone(DEFAULT_CONFIG), ...raw, defaults: { ...DEFAULT_CONFIG.defaults, ...raw.defaults } };
      cfg.projects ||= [];
      cfg.recipes ||= [];
      cfg.triggers ||= [];
      cfg.teams ||= [];
      cfg.crew ||= [];
      cfg.remote ||= {};
      cfg.machines ||= [];
      cfg.connectors ||= [];
      // Auto became the default harness: switch once, after that the user's pick sticks.
      if (!cfg.autoIntroduced) {
        if (cfg.defaults.agent !== 'auto') cfg.defaults.agentBeforeAuto = cfg.defaults.agent;
        cfg.defaults.agent = 'auto';
        cfg.defaults.model = cfg.defaults.models?.auto || '';
        cfg.defaults.effort = '';
        cfg.autoIntroduced = true;
      }
      // Full auto became the default mode: switch once from Edits (the old default); Plan and
      // any later pick stick.
      if (!cfg.fullAutoIntroduced) {
        if (cfg.defaults.mode === 'edits') cfg.defaults.mode = 'auto';
        cfg.fullAutoIntroduced = true;
      }
      // The layout switch is gone (split view is the only layout): a saved pick means nothing now.
      delete cfg.defaults.view;
      return cfg;
    } catch {
      return { ...structuredClone(DEFAULT_CONFIG), autoIntroduced: true, fullAutoIntroduced: true };
    }
  }

  saveConfig() {
    // Atomic: a crash mid-write used to leave a cut-off config.json, which loads as the defaults
    // (no projects, recipes, triggers or machines) and is then saved over.
    writeJsonAtomic(path.join(this.home, 'config.json'), this.config, 2);
  }

  // --- projects: plain folders, matched to sessions by path prefix ---
  //
  // A project is one repo, and every place can run it. path (on machine, null = this computer) is
  // where it was added; copies are its checkouts elsewhere, which wisp found or cloned there the
  // first time a task ran there: { [machine id, or HERE]: path }. repo: its origin URL, once known.

  // The project's folder on `machine` (null = this computer), or null when it has none there yet.
  pathAt(p, machine = null) {
    return (p.machine || null) === (machine || null) ? p.path : p.copies?.[machine || HERE] || null;
  }

  // machine: a folder on another computer (paths there are POSIX); null = this one.
  projectFor(cwd = '', machine = null) {
    if (!machine && this.isScratch(cwd)) return null; // never inside a project, even one at ~
    const sep = machine ? '/' : path.sep;
    let best = null;
    let len = 0;
    for (const p of this.config.projects) {
      const dir = this.pathAt(p, machine);
      if (dir && (cwd === dir || cwd.startsWith(dir + sep)) && dir.length > len) [best, len] = [p, dir.length];
    }
    return best;
  }

  // repo: the folder's origin URL. A folder of a repo that's already a project becomes that
  // project's copy on this place, so the same repo is one project wherever it's checked out.
  addProject(dir, { name, color, machine, repo } = {}) {
    const existing = this.config.projects.find((p) => this.pathAt(p, machine) === dir);
    if (existing) return existing;
    const same = repo && this.config.projects.find((p) => p.repo && sameRepo(p.repo, repo) && !this.pathAt(p, machine));
    if (same) {
      (same.copies ||= {})[machine || HERE] = dir;
      this.saveConfig();
      return same;
    }
    const used = new Set(this.config.projects.map((p) => p.color));
    const project = {
      id: Math.random().toString(36).slice(2, 10),
      name: name || (machine ? path.posix.basename(dir) : path.basename(dir)) || dir,
      path: dir,
      ...(machine && { machine }),
      ...(repo && { repo }),
      color: color || PROJECT_COLORS.find((c) => !used.has(c)) || PROJECT_COLORS[this.config.projects.length % PROJECT_COLORS.length],
      addedAt: Date.now(),
    };
    this.config.projects.push(project);
    this.saveConfig();
    return project;
  }

  // A checkout of the project on `machine`, found or cloned there (services/places.js).
  setCopy(p, machine, dir) {
    if (this.pathAt(p, machine) === dir) return;
    if ((p.machine || null) === (machine || null)) p.path = dir;
    else (p.copies ||= {})[machine || HERE] = dir;
    this.saveConfig();
  }

  // Folder-less tasks run in a throwaway directory of their own under ~/.wisp/scratch.
  scratchDir(id) {
    const dir = path.join(this.home, 'scratch', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  isScratch(dir = '') {
    return String(dir).startsWith(path.join(this.home, 'scratch') + path.sep);
  }

  touchProject(dir) {
    if (this.isScratch(dir)) return null;
    const p = this.projectFor(dir) || this.addProject(dir);
    p.lastUsedAt = Date.now();
    this.saveConfig();
    return p;
  }

  all() {
    return [...this.sessions.values()];
  }

  get(id) {
    return this.sessions.get(id);
  }

  put(session) {
    this.sessions.set(session.id, session);
    this.save(session);
  }

  // Debounced write so streaming activity doesn't hammer the disk.
  save(session, { now = false } = {}) {
    clearTimeout(this.timers.get(session.id));
    const write = () => {
      this.timers.delete(session.id);
      if (!this.sessions.has(session.id)) return;
      const file = path.join(this.dir, `${session.id}.json`);
      writeJsonAtomic(file, session);
    };
    if (now) write();
    else this.timers.set(session.id, setTimeout(write, 400));
  }

  delete(id) {
    clearTimeout(this.timers.get(id));
    const cwd = this.sessions.get(id)?.cwd;
    if (this.isScratch(cwd)) fs.rmSync(cwd, { recursive: true, force: true }); // a folder-less task's files go with it
    this.sessions.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.shots, id), { recursive: true, force: true });
  }

  // Agents save screenshots (and recordings) to /tmp, which macOS clears. Copy every local image
  // or video a turn shows into ~/.wisp/shots/<session>/ and point the block at the copy; `source`
  // keeps the original.
  keepImages(session, turn) {
    let changed = false;
    (turn.presentation?.blocks || []).forEach((b, i) => {
      const video = b?.type === 'video';
      const rel = (b?.type === 'image' || video) && (b.path || b.src);
      if (typeof rel !== 'string' || !rel || /^https?:/.test(rel)) return;
      const src = path.resolve(session.worktree?.cwd || session.cwd || this.home, rel);
      const ext = path.extname(src).toLowerCase();
      if (!(video ? VIDEO_EXT : IMAGE_EXT).has(ext) || src.startsWith(this.shots + path.sep)) return;
      try {
        const st = fs.statSync(src);
        if (!st.isFile() || st.size > (video ? MAX_KEPT_VIDEO : MAX_KEPT_IMAGE)) return;
        const dir = path.join(this.shots, session.id);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${turn.id}-${i}${ext}`);
        fs.copyFileSync(src, dest);
        Object.assign(b, { path: dest, source: rel });
        delete b.src;
        changed = true;
      } catch {
        // gone or unreadable: leave the block as it was
      }
    });
    return changed;
  }

  // A doc block names a file the agent wrote (a plan, a report). Its text goes into the turn as it
  // was then, so it still reads the same once the file changes, moves or lives on another machine.
  keepDocs(session, turn) {
    let changed = false;
    for (const b of turn.presentation?.blocks || []) {
      if (b?.type !== 'doc' || typeof b.path !== 'string' || !b.path || typeof b.text === 'string') continue;
      const abs = path.resolve(session.worktree?.cwd || session.cwd || this.home, b.path);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(Math.min(st.size, MAX_KEPT_DOC));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        Object.assign(b, { text: buf.toString('utf8'), abs }, st.size > MAX_KEPT_DOC && { truncated: true });
        changed = true;
      } catch {
        // gone or unreadable: the block says so
      }
    }
    return changed;
  }

  // A task block names another wisp task by id. Its title goes into the block as it was then, so the
  // block still reads right in exports and once that task is deleted.
  keepTasks(turn) {
    let changed = false;
    for (const b of turn.presentation?.blocks || []) {
      if (b?.type !== 'task' || typeof b.id !== 'string' || typeof b.title === 'string') continue;
      const s = this.get(b.id.trim());
      if (!s) continue;
      b.title = s.title;
      changed = true;
    }
    return changed;
  }

  flush() {
    for (const id of [...this.timers.keys()]) {
      const s = this.sessions.get(id);
      if (s) this.save(s, { now: true });
    }
  }
}

// Turns that fell back to plain text are re-parsed from their raw answer on load, so parser
// fixes repair old turns too.
function reparse(session) {
  for (const t of session.turns || []) {
    if (!t.presentation?.fallback || typeof t.raw !== 'string') continue;
    const p = parsePresentation(t.raw);
    if (!p.fallback) t.presentation = p;
  }
}
