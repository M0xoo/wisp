// What an app's code is (v1 services/stuff.js appHash, scanApp, the copy in addApp; bundle.js
// privateFile, bundlePath; app-db.js dbSpec). A write grant is tied to the hash, and the Allow card
// reads the scan. All async: these run on request paths (a view, a grant check, a save).

import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bad } from './errors.ts';
import { MAX_APP, MAX_APP_FILES, SKIP } from './items.ts';

interface AppFile {
  rel: string;
  abs: string;
  /** where a link points: it's served as what it points at */
  link: string;
  st: Stats | null;
}

async function appFiles(dir: string, rel = ''): Promise<AppFile[]> {
  const out: AppFile[] = [];
  for (const d of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(...(await appFiles(dir, r)));
      continue;
    }
    const abs = path.join(dir, r);
    const link = d.isSymbolicLink() ? await fs.readlink(abs) : '';
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isFile() || link) out.push({ rel: r, abs, link, st: st?.isFile() ? st : null });
  }
  return out;
}

interface Scan {
  sig: string;
  files: AppFile[];
  code?: string;
  settled?: boolean;
  risky?: string[];
}

// By folder, until a file's path, time or size moves, so a view of an app stays a few stats.
// ctime too: mtime and size can be put back after an edit, ctime can't.
const scanned = new Map<string, Scan>();
/** files read to hash an app since start (tests check a settled app reads none) */
export const hashReads = { n: 0 };

async function scanOf(dir: string): Promise<Scan> {
  const files = (await appFiles(dir)).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const sig = files.map((f) => `${f.rel}\0${f.link}\0${f.st?.mtimeMs}\0${f.st?.ctimeMs}\0${f.st?.size}`).join('\0');
  const had = scanned.get(dir);
  if (had?.sig === sig) return had;
  const c: Scan = { sig, files };
  scanned.set(dir, c);
  return c;
}

/** Drop a folder's cache (its item is gone). */
export const forgetScan = (dir: string): void => void scanned.delete(dir);

// The stats only vouch for a hash once they're old: a same-size edit in the same clock tick (15 ms
// on Windows, more on some disks) leaves them as they were, so a file touched just now is read every
// time (as git does).
const SETTLED_MS = 3000;
const isSettled = (c: Scan, now: number): boolean => c.files.every((f) => now - Math.max(f.st?.mtimeMs ?? 0, f.st?.ctimeMs ?? 0) > SETTLED_MS);

/** sha256 of the folder's sorted paths and contents, and the sorted uses. Throws for a folder that isn't there. */
export async function appHash(dir: string, uses: readonly string[] = [], now = Date.now()): Promise<string> {
  const c = await scanOf(dir);
  if (!c.code || !c.settled) {
    const h = crypto.createHash('sha256');
    for (const f of c.files) {
      h.update(`${f.rel}\0${f.link}\0${f.st?.size ?? ''}\0`);
      if (f.st) {
        hashReads.n++;
        h.update(await fs.readFile(f.abs));
      }
    }
    c.code = h.digest('hex');
    c.settled = isSettled(c, now); // checked after reading: an edit during the read keeps it unsettled
  }
  return crypto.createHash('sha256').update(`${c.code}\0${[...uses].sort().join('\0')}`).digest('hex');
}

// What the Allow card should say out loud. Literal names only, so it can miss code that builds them
// at run time: a warning when it finds one, no promise when it doesn't.
const WEBRTC = /RTCPeerConnection|RTCDataChannel|webkitRTC/;
export async function scanApp(dir: string): Promise<string[]> {
  const c = await scanOf(dir);
  if (!c.risky) {
    let found = false;
    for (const f of c.files) {
      if (!f.st || !/\.(html?|[cm]?js)$/i.test(f.rel)) continue;
      if (WEBRTC.test(await fs.readFile(f.abs, 'latin1'))) {
        found = true;
        break;
      }
    }
    c.risky = found ? ['webrtc'] : [];
  }
  return c.risky;
}

// What never goes in an app, saved or published: files that hold secrets, and source maps.
const ENV = /^\.env(\..*)?$/;
const PRIVATE = [
  ENV,
  /\.env$/,
  /^\.envrc$/,
  /^\.?credentials(\.(json|ya?ml|toml|ini|txt|csv|xml))?$/,
  /^client_secret.*\.json$/,
  /^service[-_]?account.*\.json$/,
  /^secrets?\.(json|ya?ml|toml)$/,
  /^\.(npmrc|netrc|pgpass|pypirc|htpasswd|git-credentials|dockercfg)$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.map$/,
];
export function privateFile(rel: string): boolean {
  const dirs = String(rel).toLowerCase().split(/[\\/]/);
  const name = dirs.pop() ?? '';
  return PRIVATE.some((re) => re.test(name)) || dirs.some((d) => ENV.test(d));
}

/** A file's path inside an app, or null when it would land outside the folder. */
export function bundlePath(p: unknown): string | null {
  // a control character or a backslash: never an app's file
  if (typeof p !== 'string' || !p || p.length > 400 || /[\x00-\x1f\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  return parts.every((x) => x && x !== '.' && x !== '..') ? parts.join('/') : null;
}

/** What wisp-app.json's "db" asks for: null (off), or { seed } (a file in the app, or ''). */
export async function dbSpec(manifest: Record<string, unknown>, dir: string): Promise<{ seed: string } | null> {
  const d = manifest['db'];
  if (!d) return null;
  if (typeof d === 'string') {
    const seed = bundlePath(d.replace(/^\/+/, ''));
    if (!seed) throw bad(`"db" in wisp-app.json names its seed file inside the app, like "seed.sql".`);
    return { seed };
  }
  return { seed: (await exists(path.join(dir, 'seed.sql'))) ? 'seed.sql' : '' };
}

export const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** Copies an app's folder without what a build makes again and without private files. */
export async function copyApp(src: string, dest: string): Promise<{ size: number; files: number }> {
  let size = 0;
  let files = 0;
  const copy = async (from: string, to: string): Promise<void> => {
    await fs.mkdir(to, { recursive: true });
    for (const d of await fs.readdir(from, { withFileTypes: true })) {
      if (SKIP.has(d.name)) continue;
      const a = path.join(from, d.name);
      const b = path.join(to, d.name);
      if (d.isDirectory()) await copy(a, b);
      else if (d.isFile() && !privateFile(path.relative(src, a))) {
        size += (await fs.stat(a)).size;
        if (++files > MAX_APP_FILES || size > MAX_APP) throw bad(`That app is too big for My Stuff (${MAX_APP_FILES} files, 200 MB at most, without node_modules).`, 413);
        await fs.copyFile(a, b);
      }
    }
  };
  try {
    await copy(src, dest);
  } catch (err) {
    await rmTree(dest);
    throw err;
  }
  return { size, files };
}

// Windows can still hold a file an app's server just sent when its folder goes: retry, don't fail.
export const rmTree = (p: string): Promise<void> => fs.rm(p, { recursive: true, force: true, maxRetries: 10 });

/** The names of an app's first files, for an agent (v1 stuffDetail's walk): at most `max`. */
export async function firstFiles(dir: string, max = 40): Promise<string[]> {
  const files: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (files.length >= max) return;
      if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
      else files.push(`${rel}${e.name}`);
    }
  };
  await walk(dir, '').catch(() => undefined);
  return files;
}
