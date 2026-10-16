// Persistence: one JSON file per session under ~/.wisp/sessions, plus config.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parsePresentation } from './protocol.js';

const DEFAULT_CONFIG = {
  projects: [], // [{ id, name, path, color, addedAt }]
  defaults: { agent: 'claude', mode: 'edits', model: '' },
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_KEPT_IMAGE = 25 * 1024 * 1024;

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
      return cfg;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  saveConfig() {
    fs.writeFileSync(path.join(this.home, 'config.json'), JSON.stringify(this.config, null, 2));
  }

  // --- projects: plain folders, matched to sessions by path prefix ---

  projectFor(cwd = '') {
    let best = null;
    for (const p of this.config.projects)
      if ((cwd === p.path || cwd.startsWith(p.path + path.sep)) && (!best || p.path.length > best.path.length)) best = p;
    return best;
  }

  addProject(dir, { name, color } = {}) {
    const existing = this.config.projects.find((p) => p.path === dir);
    if (existing) return existing;
    const used = new Set(this.config.projects.map((p) => p.color));
    const project = {
      id: Math.random().toString(36).slice(2, 10),
      name: name || path.basename(dir) || dir,
      path: dir,
      color: color || PROJECT_COLORS.find((c) => !used.has(c)) || PROJECT_COLORS[this.config.projects.length % PROJECT_COLORS.length],
      addedAt: Date.now(),
    };
    this.config.projects.push(project);
    this.saveConfig();
    return project;
  }

  touchProject(dir) {
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
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(session));
      fs.renameSync(`${file}.tmp`, file);
    };
    if (now) write();
    else this.timers.set(session.id, setTimeout(write, 400));
  }

  delete(id) {
    clearTimeout(this.timers.get(id));
    this.sessions.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.shots, id), { recursive: true, force: true });
  }

  // Agents save screenshots to /tmp, which macOS clears. Copy every local image a turn shows
  // into ~/.wisp/shots/<session>/ and point the block at the copy; `source` keeps the original.
  keepImages(session, turn) {
    let changed = false;
    (turn.presentation?.blocks || []).forEach((b, i) => {
      const rel = b?.type === 'image' && (b.path || b.src);
      if (typeof rel !== 'string' || !rel || /^https?:/.test(rel)) return;
      const src = path.resolve(session.cwd || this.home, rel);
      const ext = path.extname(src).toLowerCase();
      if (!IMAGE_EXT.has(ext) || src.startsWith(this.shots + path.sep)) return;
      try {
        const st = fs.statSync(src);
        if (!st.isFile() || st.size > MAX_KEPT_IMAGE) return;
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
