// Harness watch, the part with no plugin in it (v1 server/harness-watch.js): where a program
// resolves to, its fingerprint (cached by real path + size + mtime), how a change is classified and
// the line a task shows. Async file reads only: this runs on the run path.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ProgramAt {
  path: string;
  real: string;
}

export interface Fingerprint extends ProgramAt {
  size: number;
  mtimeMs: number;
  sha256: string;
}

// type aliases, not interfaces: they are plain JSON (a held turn's data, a row) and say so to tsc

/** what a pin or a change shows of a program */
export type Shown = {
  path: string;
  real: string;
  size: number;
  sha256: string;
  version: string;
};

export type Pin = Shown & {
  mtimeMs: number;
  at: number;
};

export type Change = {
  kind: 'update' | 'warn';
  from: Shown & { at: number };
  to: Shown & { mtimeMs: number };
  at: number;
};

/** `which` for Windows (.cmd shims): the proc service's */
export type Which = (bin: string, env: Record<string, string | undefined>) => Promise<string | null>;

async function realFile(p: string): Promise<string | null> {
  try {
    const st = await stat(p);
    return st.isFile() ? await realpath(p) : null;
  } catch {
    return null;
  }
}

/** The program `bin` names: as found (a PATH entry or the path itself) and what it really is. */
export async function resolveBin(bin: string, env: Record<string, string | undefined>, o: { platform?: string; which?: Which } = {}): Promise<ProgramAt | null> {
  if (!bin) return null;
  const platform = o.platform ?? process.platform;
  if (/[\\/]/.test(bin)) {
    const abs = path.resolve(bin);
    const r = await realFile(abs);
    if (r || platform !== 'win32') return r ? { path: abs, real: r } : null;
  }
  if (platform === 'win32') {
    const p = o.which ? await o.which(bin, env) : null;
    const r = p ? await realFile(p) : null;
    return p && r ? { path: p, real: r } : null;
  }
  for (const dir of String(env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    const r = await realFile(p);
    if (r) return { path: p, real: r };
  }
  return null;
}

/** "2.1.3 (Claude Code)" → [2, 1, 3]; [] when it names none. */
export const versionParts = (v: string | undefined): number[] =>
  (String(v ?? '').match(/\d+(?:\.\d+)+/)?.[0] ?? '').split('.').filter(Boolean).map(Number);

export function versionUp(from: string | undefined, to: string | undefined): boolean {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  return false;
}

/**
 * The folder a program is installed in, with version folders as a wildcard: an update moves
 * Cellar/codex/0.1.2/bin to Cellar/codex/0.1.3/bin, or claude's versions/2.0.1 to versions/2.0.2.
 */
export const installDir = (real: string): string =>
  path
    .dirname(real)
    .split(/[\\/]/)
    .map((seg) => (/^v?\d+\.\d+/.test(seg) ? '*' : seg))
    .join('/');

/** An update is info; anything else about a changed program is a warning. */
export function classify(pin: { real: string; version?: string }, now: { real: string; version?: string }): 'update' | 'warn' {
  return versionUp(pin.version, now.version) && installDir(pin.real) === installDir(now.real) ? 'update' : 'warn';
}

export const shown = (x: Shown): Shown => ({ path: x.path, real: x.real, size: x.size, sha256: x.sha256, version: x.version || '' });

/** The line a task and Settings show: "Claude Code changed since 2026-11-02: 2.0.1 → 2.0.2". */
export function changeLine(name: string, c: Change, date: (t: number) => string = (t) => new Date(t).toISOString().slice(0, 10)): string {
  const label = (x: Shown): string => x.version || x.path;
  const from = label(c.from);
  const to = c.kind === 'update' || c.from.real === c.to.real || c.from.path === c.to.path ? label(c.to) : `${label(c.to)} at ${c.to.path}`;
  const what = from === to ? `${from} (other bytes: ${c.to.sha256.slice(0, 12)}…)` : `${from} → ${to}`;
  return `${name} changed since ${date(c.from.at)}: ${what}`;
}

const sha256Of = (file: string): Promise<string | null> =>
  new Promise((resolve) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(null));
  });

/** Fingerprints, hashed once per real path + size + mtime: a run whose program didn't move pays one stat. */
export class Fingerprints {
  readonly #hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  readonly #env: () => Record<string, string | undefined>;
  readonly #o: { platform?: string; which?: Which };

  constructor(env: () => Record<string, string | undefined>, o: { platform?: string; which?: Which } = {}) {
    this.#env = env;
    this.#o = o;
  }

  resolve(bin: string): Promise<ProgramAt | null> {
    return resolveBin(bin, this.#env(), this.#o);
  }

  /** resolved path, size, mtime and sha256 of `bin`, or null when it isn't there */
  async of(bin: string): Promise<Fingerprint | null> {
    const at = await this.resolve(bin);
    if (!at) return null;
    let st;
    try {
      st = await stat(at.real);
    } catch {
      return null;
    }
    const hit = this.#hashes.get(at.real);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { ...at, size: st.size, mtimeMs: st.mtimeMs, sha256: hit.sha256 };
    const sha256 = await sha256Of(at.real);
    if (!sha256) return null;
    this.#hashes.set(at.real, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return { ...at, size: st.size, mtimeMs: st.mtimeMs, sha256 };
  }
}
