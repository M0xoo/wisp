// Persistence: one JSON file per session under ~/.wisp/sessions, plus config.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sameRepo } from './git.js';
import { parsePresentation } from './protocol.js';
import { activityFacts, lightFacts } from './usage.js';
import { VERSION, writeJsonAtomic } from './util.js';

// Text to a file so a crash mid-write never leaves half of it: a tmp file, then rename.
function writeAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

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

// A task's file is mostly its turns' activity, file changes and raw answers (about 85% of the
// bytes): nothing on the list needs them. Each save also writes the rest of the task to
// sessions/.light/<id>.json, stamped with the full file's mtime and size; a start reads those
// instead, and a turn's heavy fields load from the full file the first time anything reads them
// (a getter on the turn), so reading or saving a task always sees all of it.
const HEAVY = ['activity', 'changes', 'raw'];
const LIGHT = '.light';

export class Store {
  constructor(home = process.env.WISP_HOME || path.join(os.homedir(), '.wisp')) {
    this.home = home;
    this.dir = path.join(home, 'sessions');
    this.lightDir = path.join(this.dir, LIGHT);
    this.shots = path.join(home, 'shots');
    fs.mkdirSync(this.lightDir, { recursive: true });
    this.sessions = new Map();
    this.timers = new Map();
    this.lazy = new Map(); // session -> [{ turn, keys }] whose heavy fields are still on disk
    this.writes = new Map(); // file -> the number of its latest write: an older one landing late is dropped
    this.inflight = new Map(); // id -> session, written in the background right now
    this.rev = new WeakMap(); // session -> saves so far (summaries are kept per rev: runner.js listSummary)
    this.epoch = 0; // bumped by what changes other tasks' summaries: config, a task added or gone, a subagent's save
    this.config = this.#loadConfig();

    const stale = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        let s = this.#readLight(f);
        if (!s) {
          s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          stale.push(s);
        }
        // A light file written by this version already has its turns parsed by this parser.
        if (s[LIGHT] !== VERSION) {
          reparse(s);
          if (s[LIGHT] !== undefined) stale.push(s); // its light file, written again by this version
        }
        delete s[LIGHT];
        this.sessions.set(s.id, s);
        // Backfill: follow-ups queued before items had ids can't be cancelled without one.
        const ids = (s.queue || []).filter((q) => !q.id).map((q) => (q.id = randomUUID().replace(/-/g, '').slice(0, 12)));
        // Backfill: keep screenshots from older turns while their files still exist.
        if ((s.turns || []).map((t) => this.keepImages(s, t)).some(Boolean) || ids.length) this.save(s, { now: true });
      } catch (err) {
        console.warn(`wisp: skipping unreadable session ${f}: ${err.message}`);
      }
    }
    // Tasks with no light file yet (or one older than their file or this version): written behind the
    // start, so the next one is quick.
    if (stale.length) {
      const t = setTimeout(() => {
        for (const s of stale) if (this.sessions.get(s.id) === s && !this.timers.has(s.id) && !this.inflight.has(s.id)) this.#writeLight(s);
      }, 2000);
      t.unref?.();
    }
  }

  // The task from its light file, if that matches its full file; its heavy fields wait on disk.
  #readLight(f) {
    let st;
    let light;
    try {
      st = fs.statSync(path.join(this.dir, f));
      light = JSON.parse(fs.readFileSync(path.join(this.lightDir, f), 'utf8'));
    } catch {
      return null;
    }
    if (light?.mtimeMs !== st.mtimeMs || light.size !== st.size || !Array.isArray(light.session?.turns)) return null;
    const s = light.session;
    s[LIGHT] = light.v || '';
    const lazy = [];
    s.turns.forEach((turn, i) => {
      const keys = (light.lazy?.[i] || []).filter((k) => HEAVY.includes(k));
      if (!keys.length) return;
      lazy.push({ turn, keys });
      if (light.facts?.[i]) lightFacts.set(turn, light.facts[i]); // the usage stats' counts
      for (const k of keys)
        Object.defineProperty(turn, k, {
          configurable: true,
          enumerable: true,
          get: () => (this.#hydrate(s), turn[k]),
          set: (v) => (this.#hydrate(s), (turn[k] = v)),
        });
    });
    if (lazy.length) this.lazy.set(s, lazy);
    return s;
  }

  // The heavy fields of a task loaded from the light file, read from its full file now.
  #hydrate(s) {
    const lazy = this.lazy.get(s);
    if (!lazy) return;
    this.lazy.delete(s);
    let full = null;
    try {
      full = JSON.parse(fs.readFileSync(path.join(this.dir, `${s.id}.json`), 'utf8'));
    } catch {
      // gone (deleted meanwhile): what's left is empty
    }
    const turns = full?.turns || [];
    const byId = new Map(turns.map((t, i) => [t?.id ?? i, t]));
    for (const { turn, keys } of lazy) {
      lightFacts.delete(turn);
      const src = byId.get(turn.id ?? s.turns.indexOf(turn));
      for (const k of keys) {
        if (!Object.getOwnPropertyDescriptor(turn, k)?.get) continue; // deleted or replaced meanwhile
        const v = src?.[k] ?? (k === 'raw' ? undefined : []);
        if (v === undefined) delete turn[k];
        else Object.defineProperty(turn, k, { value: v, writable: true, enumerable: true, configurable: true });
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
    this.epoch++; // projects, names and colours are on every summary
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
    if (!this.sessions.has(session.id)) this.epoch++;
    this.sessions.set(session.id, session);
    this.save(session);
  }

  // Debounced write so streaming activity doesn't hammer the disk. The text is made at once, the
  // file written on the thread pool (now: right here, for a flush or a crash-sensitive step).
  save(session, { now = false } = {}) {
    this.rev.set(session, (this.rev.get(session) || 0) + 1);
    // A subagent's or crew job's state shows on its lead's row: every summary is made again.
    if (session.parentId || session.delegated || session.crew || session.relay) this.epoch++;
    clearTimeout(this.timers.get(session.id));
    const write = () => {
      this.timers.delete(session.id);
      if (!this.sessions.has(session.id)) return;
      this.#write(session, now);
    };
    if (now) write();
    else this.timers.set(session.id, setTimeout(write, 400));
  }

  #write(session, now) {
    const { id } = session;
    const file = path.join(this.dir, `${id}.json`);
    const json = JSON.stringify(session); // reads every heavy field: a light task loads them first
    const light = this.#lightJson(session);
    const n = (this.writes.get(file) || 0) + 1;
    this.writes.set(file, n);
    const land = () => {
      try {
        const st = fs.statSync(file);
        writeAtomic(path.join(this.lightDir, `${id}.json`), `{"mtimeMs":${st.mtimeMs},"size":${st.size},${light}}`);
      } catch {}
    };
    if (now) {
      this.inflight.delete(id);
      writeAtomic(file, json);
      return land();
    }
    this.inflight.set(id, session);
    const tmp = `${file}.${n}.tmp`;
    fs.writeFile(tmp, json, (err) => {
      // Only the latest write lands, and never for a task deleted meanwhile.
      if (err || this.writes.get(file) !== n || this.sessions.get(id) !== session) return fs.rm(tmp, { force: true }, () => {});
      this.inflight.delete(id);
      try {
        fs.renameSync(tmp, file);
        land();
      } catch {}
    });
  }

  // The task without its heavy fields, and which turns had which: the inside of its light file.
  #lightJson(session) {
    const lazy = [];
    const facts = [];
    const turns = (session.turns || []).map((t, i) => {
      const keys = HEAVY.filter((k) => k in t);
      if (!keys.length) return t;
      lazy[i] = keys;
      // Still on disk itself (written again before it was read): its counts as they were loaded.
      facts[i] = Object.getOwnPropertyDescriptor(t, 'activity')?.get ? lightFacts.get(t) || null : this.#factsOf(t);
      const rest = {}; // by key, not Object.entries: that would read (and load) the heavy ones
      for (const k of Object.keys(t)) if (!HEAVY.includes(k)) rest[k] = t[k];
      return rest;
    });
    return `"v":${JSON.stringify(VERSION)},"lazy":${JSON.stringify(lazy)},"facts":${JSON.stringify(facts)},"session":${JSON.stringify({ ...session, turns })}`;
  }

  // A turn's usage counts, made again only when its activity grew (a finished turn's never does).
  #facts = new WeakMap();
  #factsOf(t) {
    const n = t.activity?.length || 0;
    const kept = this.#facts.get(t);
    if (kept?.n === n && kept.list === t.activity) return kept.f;
    const f = activityFacts(t);
    this.#facts.set(t, { n, list: t.activity, f });
    return f;
  }

  // A task loaded in full (no light file yet): its light file, so the next start reads that.
  #writeLight(session) {
    const file = path.join(this.dir, `${session.id}.json`);
    try {
      const st = fs.statSync(file);
      writeAtomic(path.join(this.lightDir, `${session.id}.json`), `{"mtimeMs":${st.mtimeMs},"size":${st.size},${this.#lightJson(session)}}`);
    } catch {}
  }

  delete(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const cwd = this.sessions.get(id)?.cwd;
    if (this.isScratch(cwd)) fs.rmSync(cwd, { recursive: true, force: true }); // a folder-less task's files go with it
    const s = this.sessions.get(id);
    if (s) this.lazy.delete(s);
    this.sessions.delete(id);
    this.inflight.delete(id);
    this.epoch++;
    const file = path.join(this.dir, `${id}.json`);
    this.writes.set(file, (this.writes.get(file) || 0) + 1); // one in the background doesn't land
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(this.lightDir, `${id}.json`), { force: true });
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

  // On the way out: what's waiting to be written, and what's being written in the background, now.
  flush() {
    for (const id of new Set([...this.timers.keys(), ...this.inflight.keys()])) {
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
