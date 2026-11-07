// My Stuff's records (v1 server/services/stuff.js, class Stuff): each item is a copy in ~/.wisp/stuff
// (`<id>-<name>` holds the file), so it stays when the task, its worktree or /tmp goes. The record is
// a row in the store (one write path, the change feed tells every client) and, for one release, also
// v1's `<id>.json` beside the file, so a downgrade finds everything (ADR-0004).

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '@wisp/store';
import { effectiveGrant, WRITE_USES } from '@wisp-plugin/stuff-api';
import type { Grant, StuffItem, StuffView } from '@wisp-plugin/stuff-api';
import { appHash, exists, forgetScan, rmTree, scanApp } from './app-files.ts';
import { ITEM, LOCAL } from './schema.ts';

export interface ShelfOptions {
  store: Store;
  /** ~/.wisp/stuff */
  dir: string;
  now?: () => number;
  /** an app's launch, when it runs (apps.ts) */
  running?: (id: string) => { port: number } | null;
  /** after every commit that changed an item (the page repaints from the topic) */
  onChange?: (id: string) => void;
}

export class Shelf {
  readonly store: Store;
  readonly dir: string;
  readonly now: () => number;
  running: (id: string) => { port: number } | null;
  readonly #onChange: (id: string) => void;

  constructor(o: ShelfOptions) {
    this.store = o.store;
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.running = o.running ?? (() => null);
    this.#onChange = o.onChange ?? (() => {});
  }

  get(id: string): StuffItem | undefined {
    return this.store.get(LOCAL, id)?.record;
  }

  /** Newest first. */
  list(): StuffItem[] {
    return this.store.query(LOCAL, { order: [['at', 'desc']] }).map((r) => r.record);
  }

  /** The same thing from the same place (a reply's picture saved twice) is the one item. */
  findKey(key: string | undefined): StuffItem | undefined {
    if (!key) return undefined;
    return this.store.query(LOCAL, { where: { from_key: key }, order: [['at', 'desc']], limit: 1 })[0]?.record;
  }

  /** An app's database (app-db.ts): beside it, under its id, so it outlives updates to the app. */
  dataFile(id: string): string {
    return path.join(this.dir, `${id}-data.sqlite`);
  }

  /** Its folder as it is now, '' when that can't be read (no match: a write grant is off). */
  async hashOf(it: StuffItem): Promise<string> {
    if (!it.path) return '';
    try {
      return await appHash(it.path, it.uses ?? [], this.now());
    } catch {
      return '';
    }
  }

  /** What an app may use now. The code is only hashed for an app holding a write scope. */
  async grant(it: StuffItem): Promise<Grant> {
    const list = it.allowed ?? [];
    return effectiveGrant(list, it.grantHash ?? '', list.some((x) => WRITE_USES.includes(x)) ? await this.hashOf(it) : '');
  }

  async risky(it: StuffItem): Promise<string[]> {
    if (!it.path) return [];
    return scanApp(it.path).catch(() => []);
  }

  /** What the page sees: no paths on this computer; allowed is what holds now, never what's stored. */
  async view(it: StuffItem): Promise<StuffView> {
    const { path: _p, source: _s, prev, cover, db, allowed: _a, grantHash: _h, ...rest } = it;
    const { allowed, changed } = await this.grant(it);
    const risky = it.uses?.length ? await this.risky(it) : [];
    const running = it.kind === 'app' ? this.running(it.id) : null;
    return {
      ...rest,
      ...(allowed.length && { allowed }),
      ...(changed && { changed: true as const }),
      ...(risky.length && { risky }),
      ...(prev && { prev: { at: prev.at, ...(prev.size !== undefined && { size: prev.size }), ...(prev.by !== undefined && { by: prev.by }) } }),
      ...(cover && { cover: true as const }),
      ...(db && { db: true as const, data: await exists(this.dataFile(it.id)) }),
      ...(running && { running }),
    };
  }

  /** Writes the record and its view in one transaction (the view is worked out first: it reads files). */
  async save(it: StuffItem): Promise<StuffItem> {
    const view = await this.view(it);
    this.store.tx((w) => {
      w.upsert(LOCAL, { id: it.id, at: it.at, from_key: it.from?.key ?? null, record: it });
      w.upsert(ITEM, { id: it.id, at: it.at, view });
    });
    await this.#writeV1(it);
    this.#onChange(it.id);
    return it;
  }

  /** The view row again (a launch, a stop, Reset data): nothing in the record moved. */
  async refresh(id: string): Promise<void> {
    const it = this.get(id);
    if (!it) return;
    const view = await this.view(it);
    if (!this.get(id)) return; // removed while the view was worked out
    this.store.tx((w) => w.upsert(ITEM, { id, at: it.at, view }));
    this.#onChange(id);
  }

  /** Every file of an item (its content, the version before, its picture, its data) and its rows. */
  async drop(it: StuffItem): Promise<void> {
    this.store.tx((w) => {
      w.del(LOCAL, it.id);
      w.del(ITEM, it.id);
    });
    if (it.kind === 'app' && it.path) forgetScan(it.path);
    for (const p of [it.path, it.prev?.path, it.cover]) if (p) await rmTree(p);
    for (const f of ['', '-wal', '-shm']) await fs.rm(`${this.dataFile(it.id)}${f}`, { force: true, maxRetries: 10 });
    await fs.rm(path.join(this.dir, `${it.id}.json`), { force: true });
    this.#onChange(it.id);
  }

  // The downgrade path: v1 reads <id>.json. Written to a temp file and renamed, so it's never half there.
  async #writeV1(it: StuffItem): Promise<void> {
    const file = path.join(this.dir, `${it.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(it));
    await fs.rename(tmp, file);
  }
}
