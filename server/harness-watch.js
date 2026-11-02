// Harness watch: wisp runs claude, codex, cursor-agent, opencode, copilot… from PATH, so a program
// swapped there would run with your keys and files. The first time wisp runs a harness it pins its
// program: where it resolved to, its size, sha256 and version. When that changes, the next run says
// so: an update (the version went up, same install folder) as an info line, anything else (another
// folder, the same version with other bytes) as a warning. Trust this version pins what's there now.
// Nothing is blocked unless Settings → Agents → Ask before running a changed harness
// (defaults.harnessAsk) is on: then the run is held until you trust it (runner.js #holdTurn).
// Hashing is cached by real path + size + mtime, so a run whose program didn't move pays one stat.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { whichWindows } from './proc.js';

const FILE = 'harnesses.json';

// The program `bin` names: as found (a PATH entry or the path itself) and what it really is.
export function resolveBin(bin, env = process.env) {
  if (!bin) return null;
  const real = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() ? fs.realpathSync(p) : null;
    } catch {
      return null;
    }
  };
  if (/[\\/]/.test(bin)) {
    const r = real(path.resolve(bin));
    if (r || process.platform !== 'win32') return r ? { path: path.resolve(bin), real: r } : null;
  }
  if (process.platform === 'win32') {
    const p = whichWindows(bin, env);
    const r = p && real(p);
    return r ? { path: p, real: r } : null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    const r = real(p);
    if (r) return { path: p, real: r };
  }
  return null;
}

// "2.1.3 (Claude Code)" → [2, 1, 3]; [] when it names none.
export const versionParts = (v) => (String(v || '').match(/\d+(?:\.\d+)+/)?.[0] || '').split('.').filter(Boolean).map(Number);
export function versionUp(from, to) {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] || 0) !== (a[i] || 0)) return (b[i] || 0) > (a[i] || 0);
  return false;
}

// The folder a program is installed in, with version folders as a wildcard: an update moves
// Cellar/codex/0.1.2/bin to Cellar/codex/0.1.3/bin, or claude's versions/2.0.1 to versions/2.0.2.
export const installDir = (real) =>
  path
    .dirname(real)
    .split(/[\\/]/)
    .map((seg) => (/^v?\d+\.\d+/.test(seg) ? '*' : seg))
    .join('/');

// An update is info; anything else about a changed program is a warning.
export function classify(pin, now) {
  return versionUp(pin.version, now.version) && installDir(pin.real) === installDir(now.real) ? 'update' : 'warn';
}

const shown = ({ path: p, real, size, sha256, version }) => ({ path: p, real, size, sha256, version: version || '' });

export class HarnessWatch {
  constructor(home, { now = Date.now, env = process.env } = {}) {
    this.file = path.join(home, FILE);
    this.now = now;
    this.env = env;
    this.hashes = new Map(); // real path -> { size, mtimeMs, sha256 }
    this.busy = new Map(); // id -> the observe() in flight, so two runs at once hash once
    this.state = { pins: {}, changes: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { pins: raw.pins || {}, changes: raw.changes || {} };
    } catch {}
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  // Resolved path, size, mtime and sha256 of `bin`, or null when it isn't there. Hashed once per
  // real path + size + mtime.
  async fingerprint(bin) {
    const at = resolveBin(bin, this.env);
    if (!at) return null;
    let st;
    try {
      st = await fs.promises.stat(at.real);
    } catch {
      return null;
    }
    const hit = this.hashes.get(at.real);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { ...at, size: st.size, mtimeMs: st.mtimeMs, sha256: hit.sha256 };
    const sha256 = await new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(at.real)
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', () => resolve(null));
    });
    if (!sha256) return null;
    this.hashes.set(at.real, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return { ...at, size: st.size, mtimeMs: st.mtimeMs, sha256 };
  }

  // Without hashing: true when `bin` may not be the pinned program (it moved, or its size or
  // mtime differ). Used to hold a run before it starts; observe() then says what it really is.
  suspect(id, bin) {
    const pin = this.state.pins[id];
    if (!pin) return false;
    if (this.state.changes[id]) return true;
    const at = resolveBin(bin, this.env);
    if (!at) return false;
    try {
      const st = fs.statSync(at.real);
      return at.real !== pin.real || st.size !== pin.size || st.mtimeMs !== pin.mtimeMs;
    } catch {
      return false;
    }
  }

  // Look at `bin` for harness `id` now: pins it the first time, and records a change when it's
  // not the pinned program. Resolves the open change ({ kind, from, to, at }) or null.
  observe(id, bin, version = '') {
    if (this.busy.has(id)) return this.busy.get(id);
    const p = this.#observe(id, bin, version).finally(() => this.busy.delete(id));
    this.busy.set(id, p);
    return p;
  }

  async #observe(id, bin, version) {
    const fp = await this.fingerprint(bin);
    if (!fp) return this.state.changes[id] || null;
    const now = { ...shown(fp), mtimeMs: fp.mtimeMs, version: version || '' };
    const pin = this.state.pins[id];
    if (!pin) {
      this.state.pins[id] = { ...now, at: this.now() };
      this.#save();
      return null;
    }
    if (pin.sha256 === now.sha256 && pin.real === now.real) {
      // The same program (touched, or a version we didn't know yet): keep the pin current.
      const open = this.state.changes[id];
      if (pin.mtimeMs !== now.mtimeMs || (now.version && pin.version !== now.version) || open) {
        Object.assign(pin, { mtimeMs: now.mtimeMs, ...(now.version && { version: now.version }) });
        delete this.state.changes[id];
        this.#save();
      }
      return null;
    }
    const open = this.state.changes[id];
    if (open?.to.sha256 === now.sha256 && open.to.real === now.real) return open;
    // A change on top of an untrusted change still compares with what you last trusted.
    this.state.changes[id] = { kind: classify(pin, now), from: { ...shown(pin), at: pin.at }, to: now, at: this.now() };
    this.#save();
    return this.state.changes[id];
  }

  change(id) {
    return this.state.changes[id] || null;
  }

  // Trust this version: what's there now becomes the pin. false when nothing changed.
  trust(id) {
    const c = this.state.changes[id];
    if (!c) return false;
    this.state.pins[id] = { ...c.to, at: this.now() };
    delete this.state.changes[id];
    this.#save();
    return true;
  }

  // For the harness list: each harness's pin date and open change.
  view(id) {
    const pin = this.state.pins[id];
    const c = this.state.changes[id];
    return { ...(pin && { pinnedAt: pin.at }), ...(c && { changed: c }) };
  }
}

// The line a task and Settings show: "Claude Code changed since 2 Nov: 2.0.1 → 2.0.2".
export function changeLine(name, c, date = (t) => new Date(t).toISOString().slice(0, 10)) {
  const label = (x) => x.version || x.path;
  const from = label(c.from);
  const to = c.kind === 'update' || c.from.real === c.to.real || c.from.path === c.to.path ? label(c.to) : `${label(c.to)} at ${c.to.path}`;
  const what = from === to ? `${from} (other bytes: ${c.to.sha256.slice(0, 12)}…)` : `${from} → ${to}`;
  return `${name} changed since ${date(c.from.at)}: ${what}`;
}
