// Content-addressed blobs (plan §4.1): diffs, raw answers, attachments, screenshots. Keyed by hash,
// so a diff snapshot that repeats is stored once. Small ones live in the row, big ones in
// <home>/blobs/ab/cdef…, written temp + rename so a crash never leaves half a file under a real name.
//
// The plan names BLAKE3; node:crypto has none and a dependency would need an ADR, so this is sha256.
// The algorithm is part of every hash ('sha256:…'), so a later one can live beside it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { StatementSync } from 'node:sqlite';
import { StoreError, invalid } from './errors.ts';

export const INLINE_MAX = 64 * 1024;
const ALGO = 'sha256';
/** an orphan file younger than this may belong to a put whose row has not committed yet */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type Codec = 'zstd' | 'br' | 'raw';

export interface BlobInfo {
  hash: string;
  size: number;
  codec: Codec;
  inline: boolean;
}

export interface GcResult {
  blobs: number;
  files: number;
  bytes: number;
}

interface Env {
  stmt(sql: string): StatementSync;
  tx<T>(fn: () => T): T;
  home: string | undefined;
  now(): number;
}

// zstd landed in node:zlib in 22.15 / 23.8; older runtimes fall back to brotli.
const hasZstd = typeof zlib.zstdCompressSync === 'function';

function compress(data: Uint8Array): { codec: Codec; bytes: Uint8Array } {
  const packed = hasZstd ? zlib.zstdCompressSync(data) : zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  // Already-compressed content (PNG, MP4) doesn't shrink: keep it as it is.
  if (packed.length >= data.length) return { codec: 'raw', bytes: data };
  return { codec: hasZstd ? 'zstd' : 'br', bytes: packed };
}

function decompress(codec: string, bytes: Uint8Array): Buffer {
  if (codec === 'raw') return Buffer.from(bytes);
  if (codec === 'br') return zlib.brotliDecompressSync(bytes);
  if (codec === 'zstd') {
    if (!hasZstd) throw new StoreError('internal', 'this blob is zstd-compressed and this Node has no zstd: update Node to ≥ 22.15');
    return zlib.zstdDecompressSync(bytes);
  }
  throw new StoreError('internal', `unknown blob codec ${codec}`);
}

export function hashOf(data: Uint8Array): string {
  return `${ALGO}:${createHash(ALGO).update(data).digest('hex')}`;
}

export class Blobs {
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  /** Stores bytes (once per content) and, given an owner, refs them for it. Returns the hash. */
  put(data: Uint8Array | string, owner?: { kind: string; id: string }): BlobInfo {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const hash = hashOf(bytes);
    return this.#env.tx(() => {
      const had = this.#env.stmt('SELECT size, codec, data IS NOT NULL AS inline FROM blob WHERE hash = ?').get(hash);
      let info: BlobInfo;
      if (had) info = { hash, size: Number(had['size']), codec: had['codec'] as Codec, inline: had['inline'] === 1 };
      else info = this.#write(hash, bytes);
      if (owner) this.ref(hash, owner.kind, owner.id);
      return info;
    });
  }

  #write(hash: string, bytes: Uint8Array): BlobInfo {
    const { codec, bytes: packed } = compress(bytes);
    const inline = packed.length <= INLINE_MAX || this.#env.home === undefined; // in memory: no files
    if (!inline) writeFileAtomic(this.#path(hash), packed);
    this.#env.stmt('INSERT INTO blob (hash, size, codec, data, at) VALUES (?, ?, ?, ?, ?)').run(hash, bytes.length, codec, inline ? packed : null, this.#env.now());
    return { hash, size: bytes.length, codec, inline };
  }

  get(hash: string): Buffer | undefined {
    const row = this.#env.stmt('SELECT codec, data FROM blob WHERE hash = ?').get(hash);
    if (!row) return undefined;
    const data = row['data'];
    if (data instanceof Uint8Array) return decompress(String(row['codec']), data);
    let packed: Buffer;
    try {
      packed = fs.readFileSync(this.#path(hash));
    } catch {
      throw new StoreError('not_found', `blob ${hash} is recorded but its file is missing`);
    }
    return decompress(String(row['codec']), packed);
  }

  has(hash: string): boolean {
    return this.#env.stmt('SELECT 1 FROM blob WHERE hash = ?').get(hash) !== undefined;
  }

  ref(hash: string, ownerKind: string, ownerId: string): void {
    if (!this.has(hash)) throw new StoreError('not_found', `no blob ${hash}`);
    this.#env.stmt('INSERT OR IGNORE INTO blob_ref (hash, owner_kind, owner_id) VALUES (?, ?, ?)').run(hash, ownerKind, ownerId);
  }

  unref(hash: string, ownerKind: string, ownerId: string): void {
    this.#env.stmt('DELETE FROM blob_ref WHERE hash = ? AND owner_kind = ? AND owner_id = ?').run(hash, ownerKind, ownerId);
  }

  /** Drops every ref an owner holds (a session deleted). */
  unrefOwner(ownerKind: string, ownerId: string): number {
    return Number(this.#env.stmt('DELETE FROM blob_ref WHERE owner_kind = ? AND owner_id = ?').run(ownerKind, ownerId).changes);
  }

  refs(hash: string): number {
    return Number(this.#env.stmt('SELECT count(*) AS n FROM blob_ref WHERE hash = ?').get(hash)?.['n'] ?? 0);
  }

  /** Removes blobs nobody refs, and files under blobs/ that no row names (a put that rolled back). */
  gc(): GcResult {
    const out: GcResult = { blobs: 0, files: 0, bytes: 0 };
    const gone = this.#env.tx(() => {
      const rows = this.#env.stmt('SELECT hash, size, data IS NULL AS ondisk FROM blob WHERE NOT EXISTS (SELECT 1 FROM blob_ref r WHERE r.hash = blob.hash)').all();
      for (const r of rows) {
        this.#env.stmt('DELETE FROM blob WHERE hash = ?').run(String(r['hash']));
        out.blobs++;
        out.bytes += Number(r['size']);
      }
      return rows.filter((r) => r['ondisk'] === 1).map((r) => String(r['hash']));
    });
    // Files go after the rows commit: a crash in between leaves an orphan file, never a row without one.
    for (const h of gone) {
      fs.rmSync(this.#path(h), { force: true });
      out.files++;
    }
    out.files += this.#sweepOrphans();
    return out;
  }

  #sweepOrphans(): number {
    const root = this.#env.home ? path.join(this.#env.home, 'blobs') : undefined;
    if (!root || !fs.existsSync(root)) return 0;
    let n = 0;
    const cutoff = this.#env.now() - ORPHAN_GRACE_MS;
    for (const dir of fs.readdirSync(root)) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const f of fs.readdirSync(path.join(root, dir))) {
        const file = path.join(root, dir, f);
        const hex = `${dir}${f}`;
        const orphan = !/^[0-9a-f]{64}$/.test(hex) || !this.has(`${ALGO}:${hex}`);
        if (orphan && fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          n++;
        }
      }
    }
    return n;
  }

  #path(hash: string): string {
    const [algo, hex] = hash.split(':');
    if (algo !== ALGO || !hex || !/^[0-9a-f]{64}$/.test(hex)) throw invalid(`bad blob hash ${hash}`);
    return path.join(this.#env.home as string, 'blobs', hex.slice(0, 2), hex.slice(2)); // only on-disk blobs get here, and those need a home
  }
}

function writeFileAtomic(file: string, data: Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
