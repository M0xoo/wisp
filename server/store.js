// Persistence: one JSON file per session under ~/.wisp/sessions, plus config.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePresentation } from './protocol.js';

const DEFAULT_CONFIG = {
  projects: [], // [{ id, name, path, color, addedAt }]
  defaults: { agent: 'claude', mode: 'edits', model: '' },
};

export const PROJECT_COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];

export class Store {
  constructor(home = process.env.WISP_HOME || path.join(os.homedir(), '.wisp')) {
    this.home = home;
    this.dir = path.join(home, 'sessions');
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
