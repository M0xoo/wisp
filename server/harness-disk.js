// The harnesses' own disk (design/machine.md → Harness data): what Claude Code, Codex, Cursor,
// opencode, Antigravity, Copilot and Grok keep in their own folders, for This Mac's Free up space.
// Those folders hold sign-ins and API keys: sizes come from `du` and removals from names and stat
// alone. Nothing here opens or reads a file.
//
// Only two kinds of thing are wisp's to remove: crash dumps (a Crashpad's completed/pending/new, or
// a `crashes` folder) older than an hour, and Claude Code's `claude-*-cwd` temp files older than a
// day that no running process names. The rest is the CLI's own: each harness gets a `how` line
// naming its own way to keep less.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const FRESH_MS = 6 * 3_600_000; // a du this recent stands (a removal measures again)
export const CRASH_MIN_MS = 3_600_000; // a dump this young may still be being written
export const CWD_MIN_MS = 86_400_000;
const CWD_FILE = /^claude-[0-9a-f]{4,}-cwd$/;
const CRASHPAD_PARTS = ['completed', 'pending', 'new'];
const WALK_MAX = 5000; // files looked at per crash folder

// The folders each harness keeps, for this platform and env. parts: what's measured. crash: where
// its crash dumps go. cwd: folders Claude Code drops its cwd files in.
// tmps: where Claude Code's temp files go (/tmp and the OS's temp folder; a test passes its own).
export function harnessFolders({ home = os.homedir(), platform = process.platform, env = process.env, tmp = os.tmpdir(), uid = process.getuid?.(), tmps } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix; // paths as the platform being read writes them
  const j = (...p) => P.join(...p);
  const lib = (...p) => (platform === 'darwin' ? [j(home, 'Library', 'Application Support', ...p)] : []);
  const data = env.XDG_DATA_HOME || j(home, '.local', 'share');
  const cache = env.XDG_CACHE_HOME || j(home, '.cache');
  tmps ??= [...new Set(['/tmp', tmp].filter((d) => platform !== 'win32' && d))];
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      parts: [
        { label: 'Claude Code', path: env.CLAUDE_CONFIG_DIR || j(home, '.claude') },
        ...lib('Claude', 'vm_bundles').map((p) => ({ label: 'Cowork’s VM', path: p })),
        ...(uid != null ? tmps.map((d) => ({ label: 'Temp files', path: j(d, `claude-${uid}`) })) : []),
      ],
      crash: lib('Claude', 'Crashpad'),
      cwd: tmps,
      how: 'Claude Code deletes chats older than cleanupPeriodDays (30 by default) in ~/.claude/settings.json: set it lower to keep less. Cowork’s VM comes back when Cowork next runs.',
    },
    {
      id: 'codex',
      name: 'Codex',
      parts: [{ label: 'Codex', path: env.CODEX_HOME || j(home, '.codex') }, ...lib('Codex').map((p) => ({ label: 'Codex app', path: p }))],
      crash: [j(env.CODEX_HOME || j(home, '.codex'), 'Crashpad'), ...lib('Codex', 'Crashpad')],
      how: 'Codex keeps every session and its logs (sessions/, logs_*.sqlite) with no limit of its own: archive old threads in Codex, or remove old sessions/ folders with Codex closed.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      parts: [{ label: 'Cursor agent', path: j(home, '.cursor') }, ...lib('Cursor').map((p) => ({ label: 'Cursor app', path: p }))],
      crash: lib('Cursor', 'Crashpad'),
      how: 'Cursor keeps chats and extensions here: delete old chats in Cursor, and remove extensions you don’t use from its Extensions view.',
    },
    {
      id: 'opencode',
      name: 'opencode',
      parts: [{ label: 'opencode', path: j(data, 'opencode') }, { label: 'Cache', path: j(cache, 'opencode') }],
      crash: [],
      how: 'opencode keeps every session in storage/ with no limit of its own: delete old sessions from opencode’s session list.',
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      parts: [{ label: 'Antigravity', path: j(home, '.gemini') }, ...lib('Antigravity').map((p) => ({ label: 'Antigravity app', path: p }))],
      crash: [j(home, '.gemini', 'antigravity', 'crashes'), j(home, '.gemini', 'antigravity-cli', 'crashes'), ...lib('Antigravity', 'Crashpad')],
      how: 'Antigravity keeps its agents’ scratch folders, conversations and browser recordings under ~/.gemini/antigravity: delete old conversations in Antigravity.',
    },
    { id: 'copilot', name: 'Copilot CLI', parts: [{ label: 'Copilot CLI', path: j(home, '.copilot') }], crash: [], how: 'Copilot CLI keeps its sessions here with no limit of its own.' },
    { id: 'grok', name: 'Grok', parts: [{ label: 'Grok', path: j(home, '.grok') }], crash: [], how: 'Grok keeps its sessions here with no limit of its own.' },
  ];
}

// `du -sk a b …`: bytes by path. Empty where there's no du (Windows).
export function parseDu(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) out.set(m[2], Number(m[1]) * 1024);
  }
  return out;
}

const du = (paths) =>
  new Promise((resolve) => {
    // Some of it unreadable: du still prints the rest, and fails.
    execFile('du', ['-sk', ...paths], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (_err, out) => resolve(String(out || '')));
  });

const tilde = (p, home, sep) => (p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p);

export class HarnessDisk {
  // inUse(name): a running process names this file (machine.js's last ps). busy(): the machine is
  // short (load.js busy()): the du waits.
  constructor({ home = os.homedir(), platform = process.platform, env = process.env, tmp = os.tmpdir(), uid = process.getuid?.(), tmps, run = du, fsx = fs, now = () => Date.now(), inUse = () => false, busy = () => false } = {}) {
    Object.assign(this, { home, platform, run, fsx, now, inUse, busy });
    this.list = harnessFolders({ home, platform, env, tmp, uid, tmps });
    this.sep = platform === 'win32' ? '\\' : '/';
    this.last = null; // { at, sizes: Map, removable: { id: [{ path, bytes }] } }
    this.looking = null;
  }

  exists(p) {
    try {
      this.fsx.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  }

  // Files under dir with lstat only, never followed through a link.
  #walk(dir, keep, depth = 0, out = []) {
    let entries;
    try {
      entries = this.fsx.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (out.length >= WALK_MAX) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) this.#walk(p, keep, depth + 1, out);
      else if (e.isFile()) {
        try {
          const st = this.fsx.lstatSync(p);
          if (keep(st)) out.push({ path: p, bytes: st.size });
        } catch {}
      }
    }
    return out;
  }

  // What may go now, by harness: crash dumps and stale cwd files.
  removable() {
    const now = this.now();
    const out = {};
    for (const h of this.list) {
      const files = [];
      for (const dir of h.crash || []) {
        const old = (st) => now - st.mtimeMs >= CRASH_MIN_MS;
        if (path.basename(dir) === 'Crashpad') for (const part of CRASHPAD_PARTS) files.push(...this.#walk(path.join(dir, part), old));
        else files.push(...this.#walk(dir, old));
      }
      for (const dir of h.cwd || []) {
        let names = [];
        try {
          names = this.fsx.readdirSync(dir);
        } catch {}
        for (const name of names) {
          if (!CWD_FILE.test(name)) continue;
          const p = path.join(dir, name);
          try {
            const st = this.fsx.lstatSync(p);
            if (st.isFile() && now - st.mtimeMs >= CWD_MIN_MS && !this.inUse(name)) files.push({ path: p, bytes: st.size });
          } catch {}
        }
      }
      if (files.length) out[h.id] = files;
    }
    return out;
  }

  // One du over every folder that's there. Awaited in tests.
  async look() {
    return (this.looking ||= (async () => {
      const parts = this.list.flatMap((h) => h.parts.map((x) => x.path)).filter((p) => this.exists(p));
      // Windows has no du: no sizes there (a test hands in its own run).
      const sizes = parts.length && (this.platform !== 'win32' || this.run !== du) ? parseDu(await this.run(parts)) : new Map();
      this.last = { at: this.now(), sizes, removable: this.removable() };
      return this.last;
    })().finally(() => (this.looking = null)));
  }

  // The reclaim group for GET /machine, or null before the first look. Stale (6 h): looks again
  // in the background, unless the machine is short.
  view() {
    if ((!this.last || this.now() - this.last.at > FRESH_MS) && !this.looking && !this.busy()) this.look().catch(() => {});
    if (!this.last) return null;
    const { sizes, removable } = this.last;
    const harnesses = this.list
      .map((h) => {
        const parts = h.parts.filter((x) => sizes.has(x.path)).map((x) => ({ label: x.label, path: tilde(x.path, this.home, this.sep), bytes: sizes.get(x.path) }));
        const files = removable[h.id] || [];
        return { id: h.id, name: h.name, bytes: parts.reduce((n, x) => n + x.bytes, 0), parts, removable: { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }, how: h.how };
      })
      .filter((h) => h.parts.length || h.removable.count)
      .sort((a, b) => b.bytes - a.bytes);
    if (!harnesses.length) return null;
    const ids = harnesses.filter((h) => h.removable.count).map((h) => h.id);
    return { kind: 'harness', count: harnesses.reduce((n, h) => n + h.removable.count, 0), bytes: harnesses.reduce((n, h) => n + h.removable.bytes, 0), ids, total: harnesses.reduce((n, h) => n + h.bytes, 0), measuredAt: this.last.at, harnesses };
  }

  // POST /machine/harness/clean { ids }: the removable files of those harnesses (all, without ids),
  // checked again now. { removed, freed }. Then measures again.
  async clean(ids) {
    const want = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    const now = this.removable();
    let removed = 0;
    let freed = 0;
    for (const [id, files] of Object.entries(now)) {
      if (want && !want.has(id)) continue;
      for (const f of files) {
        try {
          this.fsx.unlinkSync(f.path);
          removed++;
          freed += f.bytes;
        } catch {}
      }
    }
    if (removed) this.look().catch(() => {});
    else if (this.last) this.last.removable = this.removable();
    return { removed, freed };
  }
}
