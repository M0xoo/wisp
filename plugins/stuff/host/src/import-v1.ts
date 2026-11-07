// v1 kept My Stuff and uploads as one `<id>.json` per item beside its file (~/.wisp/stuff,
// ~/.wisp/uploads). Their records come into the store at start, in the background, resumable by
// (file, mtime, size) (@wisp/store importFiles); the files themselves stay where they are. v1 loaded
// only items whose file is still there (a link has none): so does this.

import { existsSync } from 'node:fs';
import { importFiles } from '@wisp/store';
import type { ImportReport, Store } from '@wisp/store';
import type { StuffItem, StuffView, Upload } from '@wisp-plugin/stuff-api';
import { ITEM, LOCAL, UPLOAD } from './schema.ts';

const V1_ID = /^[0-9a-f]{12}\.json$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A v1 record worth keeping: an id, and a link or a file that's still there. */
export function v1Item(v: unknown): StuffItem | null {
  if (!isObj(v) || typeof v['id'] !== 'string' || typeof v['kind'] !== 'string') return null;
  // runs inside the importer's transaction, at start: existsSync is the startup exception
  if (v['kind'] !== 'link' && !(typeof v['path'] === 'string' && existsSync(v['path']))) return null;
  return { size: 0, at: 0, by: 'you', name: String(v['id']), title: String(v['id']), ...v } as StuffItem;
}

/** What the page sees before the view is worked out again (no paths, no grant hash). */
function firstView(it: StuffItem): StuffView {
  const { path: _p, source: _s, prev, cover, db, allowed: _a, grantHash: _h, ...rest } = it;
  return { ...rest, ...(prev && { prev: { at: prev.at } }), ...(cover && { cover: true as const }), ...(db && { db: true as const }) };
}

export async function importStuff(store: Store, dir: string, signal?: AbortSignal): Promise<ImportReport> {
  return importFiles(store, {
    name: 'stuff.items',
    dir,
    pattern: V1_ID,
    ...(signal && { signal }),
    handle(file, w) {
      const it = v1Item(file.json());
      if (!it) return;
      w.upsert(LOCAL, { id: it.id, at: it.at, from_key: it.from?.key ?? null, record: it });
      w.upsert(ITEM, { id: it.id, at: it.at, view: firstView(it) });
    },
  });
}

export async function importUploads(store: Store, dir: string, signal?: AbortSignal): Promise<ImportReport> {
  return importFiles(store, {
    name: 'stuff.uploads',
    dir,
    pattern: V1_ID,
    ...(signal && { signal }),
    handle(file, w) {
      const u = file.json() as Partial<Upload> | null;
      if (!isObj(u) || typeof u.id !== 'string' || typeof u.path !== 'string') return;
      w.upsert(UPLOAD, { id: u.id, name: String(u.name ?? 'file'), mime: String(u.mime ?? 'application/octet-stream'), size: Number(u.size) || 0, path: u.path, at: Math.round(file.mtimeMs) });
    },
  });
}

/** The ids an import brought in (their views are then worked out properly). */
export const importedIds = (r: ImportReport): string[] => r.imported.map((f) => f.replace(/\.json$/, ''));
