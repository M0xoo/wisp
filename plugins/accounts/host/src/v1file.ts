// v1's ~/.wisp/accounts.json (plan §4.8): imported into accounts_account through the store's import
// mechanism, and, for the one release of the downgrade path, written again after every change, so
// going back to v1 loses nothing. After its own write the import mark is moved to the file as written,
// so a restart doesn't import back a file the rows are already newer than; a file v1 changed since
// (after a downgrade) has another mtime and is imported again.

import fs from 'node:fs/promises';
import path from 'node:path';
import { importFiles, JsonFile } from '@wisp/store';
import type { ImportFile, ImportReport, Store, Writer } from '@wisp/store';
import { type Raw, rowOf } from './book.ts';
import { rec, str } from './ports.ts';
import { ACCOUNT } from './schema.ts';

export const FILE = 'accounts.json';
const IMPORT = 'accounts.v1';
const MARK = `import:${IMPORT}:${FILE}`;
// An id becomes a folder name under accounts/<harness>/: nothing that could leave it.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One v1 entry, as v1 read it (`a && typeof a.id === 'string'`), or null. */
export function rawFrom(v: unknown): Raw | null {
  const a = rec(v);
  if (typeof a['id'] !== 'string' || !SAFE_ID.test(a['id'])) return null;
  const limit = rec(a['limit']);
  return {
    id: a['id'],
    label: str(a['label']),
    ...(typeof a['email'] === 'string' && a['email'] && { email: a['email'] }),
    ...(typeof a['plan'] === 'string' && a['plan'] && { plan: a['plan'] }),
    ...(typeof a['kind'] === 'string' && { kind: a['kind'] }),
    ...(typeof a['signedIn'] === 'boolean' && { signedIn: a['signedIn'] }),
    ...(typeof limit['until'] === 'number' && { limit: { until: limit['until'], why: str(limit['why']) } }),
    ...(typeof a['addedAt'] === 'number' && { addedAt: a['addedAt'] }),
  };
}

/** The file's lists replace the rows: it is what v1 last saw. Safe to run again (it upserts). */
export function handle(file: ImportFile, w: Writer, existing: readonly { key: string; agent: string }[]): void {
  const state = rec(file.json());
  const keep = new Set<string>();
  for (const [agent, list] of Object.entries(state)) {
    if (!Array.isArray(list)) continue;
    list.map(rawFrom).filter((a): a is Raw => a !== null).forEach((a, i) => {
      const row = rowOf(agent, a, i);
      keep.add(row.key);
      w.upsert(ACCOUNT, row);
    });
  }
  for (const r of existing) if (!keep.has(r.key)) w.del(ACCOUNT, r.key);
}

export function importV1(store: Store, wispHome: string): Promise<ImportReport> {
  return importFiles(store, {
    name: IMPORT,
    dir: wispHome,
    pattern: (n) => n === FILE,
    handle: (file, w) => handle(file, w, store.query(ACCOUNT, { select: ['key', 'agent'] })),
  });
}

/** The downgrade path's writer: v1's file kept current, in the background, newest write wins. */
export class V1Mirror {
  readonly #file: JsonFile<Record<string, Raw[]>>;
  readonly #store: Pick<Store, 'setMeta'>;

  constructor(store: Pick<Store, 'setMeta'>, wispHome: string) {
    this.#store = store;
    this.#file = new JsonFile(path.join(wispHome, FILE), { space: 2 });
  }

  async save(state: Record<string, Raw[]>): Promise<void> {
    if (!(await this.#file.save(state))) return; // a newer save made this one moot
    const st = await fs.stat(this.#file.path);
    this.#store.setMeta(MARK, JSON.stringify({ mtimeMs: st.mtimeMs, size: st.size }));
  }
}
