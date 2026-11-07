// Attachments (v1 server/services/uploads.js): raw bodies streamed to disk, referenced by id from
// launches and replies. Each upload is `<id>-<name>` in ~/.wisp/uploads; its record is a row in the
// store and, for one release, v1's `<id>.json` beside it (the downgrade path).

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '@wisp/store';
import type { Upload } from '@wisp-plugin/stuff-api';
import { bad } from './errors.ts';
import { newId } from './items.ts';
import { MIME } from './mime.ts';
import { streamTo } from './save.ts';
import { UPLOAD, uploadOf } from './schema.ts';

export const MAX_UPLOAD = 500 * 1024 * 1024;

const uploadName = (name: unknown): string => path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';

export class Uploads {
  readonly dir: string;
  readonly #store: Store;
  readonly #now: () => number;

  constructor(store: Store, dir: string, now: () => number = Date.now) {
    this.#store = store;
    this.dir = dir;
    this.#now = now;
  }

  get(id: string): Upload | undefined {
    const r = this.#store.get(UPLOAD, id);
    return r ? uploadOf(r) : undefined;
  }

  /** Upload ids from a request body → their records (unknown ids are dropped). */
  resolve(ids: unknown): Upload[] {
    return Array.isArray(ids) ? ids.flatMap((i) => (typeof i === 'string' && this.get(i) ? [this.get(i) as Upload] : [])) : [];
  }

  /** A file to fill in here (a moved task's bundle): its path; commit() once it's written. */
  reserve(name: string): { id: string; file: string } {
    const id = newId();
    return { id, file: path.join(this.dir, `${id}-${uploadName(name)}`) };
  }

  async commit(id: string, name: string): Promise<Upload> {
    const file = path.join(this.dir, `${id}-${uploadName(name)}`);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) throw bad('That upload was never written.', 404);
    return this.#record({ id, name: uploadName(name), size: st.size, mime: 'application/octet-stream', path: file });
  }

  async remove(id: string): Promise<boolean> {
    const u = this.get(id);
    if (!u) return false;
    this.#store.tx((w) => w.del(UPLOAD, id));
    await fs.rm(u.path, { force: true });
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  async receive(body: AsyncIterable<Uint8Array>, { name, type }: { name?: string | null | undefined; type?: string | null | undefined }): Promise<Upload> {
    const n = uploadName(name);
    const id = newId();
    const file = path.join(this.dir, `${id}-${n}`);
    const size = await streamTo(file, body, MAX_UPLOAD, 'file too large (500 MB max)');
    return this.#record({ id, name: n, size, mime: type || MIME[path.extname(n).toLowerCase()] || 'application/octet-stream', path: file });
  }

  async #record(u: Upload): Promise<Upload> {
    this.#store.tx((w) => w.upsert(UPLOAD, { ...u, at: this.#now() }));
    const json = path.join(this.dir, `${u.id}.json`);
    await fs.writeFile(`${json}.tmp`, JSON.stringify(u));
    await fs.rename(`${json}.tmp`, json);
    return u;
  }
}
