// Copy of v1 server/bundle.js (privateFile, publicFile, packDir, bundlePath, unpackTo); the grid
// serves what wisp packed, so the format must match. When the owner plugin (stuff) publishes these
// from its api, import them from there and delete this copy.
//
// A folder as one request body. Both ends are wisp, so no tar: each file is a 4-byte length, a JSON
// header ({ path, size }) and its bytes. Async here (v1's were sync): the grid packs and unpacks on
// request paths, and AGENTS.md keeps those free of blocking I/O.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILES = 5000;

// What never goes in an app, saved or published: files that hold secrets, and source maps (they
// hand out the source). One list for My Stuff, Publish and the grid.
const ENV = /^\.env(\..*)?$/;
const PRIVATE: readonly RegExp[] = [
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
const segments = (rel: string): string[] => String(rel).toLowerCase().split(/[\\/]/);

/** A file's path in an app: does it hold a secret (or a source map)? */
export function privateFile(rel: string): boolean {
  const dirs = segments(rel);
  const name = dirs.pop() ?? '';
  return PRIVATE.some((re) => re.test(name)) || dirs.some((d) => ENV.test(d));
}

/** May a visitor of a published app open this file? Nothing private and no dotfile, but a top-level .well-known. */
export function publicFile(rel: string): boolean {
  return !privateFile(rel) && segments(rel).every((s, i) => !s.startsWith('.') || (i === 0 && s === '.well-known'));
}

export interface Packed {
  body: Buffer;
  size: number;
  files: number;
  list: { path: string; data: Buffer }[];
}

export class TooBig extends Error {
  readonly tooBig = true;
  constructor() {
    super('too big');
  }
}

/** Every file under dir, relative paths with forward slashes; skip(path) leaves one out. */
export async function packDir(dir: string, { maxBytes = Infinity, skip }: { maxBytes?: number; skip?: (rel: string) => boolean } = {}): Promise<Packed> {
  const parts: Buffer[] = [];
  const list: Packed['list'] = [];
  let size = 0;
  let files = 0;
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile() && !skip?.(r)) {
        const data = await fs.promises.readFile(abs);
        size += data.length;
        if (++files > MAX_FILES || size > maxBytes) throw new TooBig();
        const head = Buffer.from(JSON.stringify({ path: r, size: data.length }));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(head.length);
        parts.push(len, head, data);
        list.push({ path: r, data });
      }
    }
  };
  await walk(dir, '');
  return { body: Buffer.concat(parts), size, files, list };
}

/** A file's path from a bundle, or null when it would land outside the folder. */
export function bundlePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 400 || /[\x00-\x1f\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  return parts.every((x) => x && x !== '.' && x !== '..') ? parts.join('/') : null;
}

interface Entry {
  rel: string;
  start: number;
  len: number;
}

// Reads one file header at `at`: where its bytes are, or throws on anything malformed.
function entryAt(buf: Buffer, at: number): Entry & { next: number } {
  if (at + 4 > buf.length) throw new Error('The bundle ends early.');
  const n = buf.readUInt32BE(at);
  const h = at + 4;
  if (n > 2048 || h + n > buf.length) throw new Error('A file header in the bundle is broken.');
  let head: { path?: unknown; size?: unknown };
  try {
    head = JSON.parse(buf.subarray(h, h + n).toString('utf8')) as { path?: unknown; size?: unknown };
  } catch {
    throw new Error('A file header in the bundle is broken.');
  }
  const start = h + n;
  const rel = bundlePath(head?.path);
  const len = Number(head?.size);
  if (!rel || !Number.isInteger(len) || len < 0 || start + len > buf.length) throw new Error(`The bundle has a bad file: ${String(head?.path).slice(0, 80)}`);
  return { rel, start, len, next: start + len };
}

/** Write a bundle into dir (which it makes), but for the files skip(path) names. Throws on anything malformed. */
export async function unpackTo(buf: Buffer, dir: string, { skip }: { skip?: (rel: string) => boolean } = {}): Promise<{ files: number; size: number }> {
  await fs.promises.mkdir(dir, { recursive: true });
  let at = 0;
  let files = 0;
  let size = 0;
  while (at < buf.length) {
    const e = entryAt(buf, at);
    at = e.next;
    if (skip?.(e.rel)) continue;
    if (++files > MAX_FILES) throw new Error(`More than ${MAX_FILES} files.`);
    const file = path.join(dir, ...e.rel.split('/'));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // wx: a bundle naming one path twice (or a file inside a "file") is refused, never overwritten
    await fs.promises.writeFile(file, buf.subarray(e.start, e.start + e.len), { flag: 'wx' });
    size += e.len;
  }
  return { files, size };
}
