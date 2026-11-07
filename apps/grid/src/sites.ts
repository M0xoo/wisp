// Published apps: an app from someone's My Stuff (static files: HTML, JS, CSS), put on the grid so
// anyone with the link can open it. It lives here, not in their box, so it answers while their
// wisp sleeps and their computers are off.
//
// Address: <slug>--app--<handle>.<domain>. Three parts, so never a computer (<name>--<handle>), and
// a slug is never p<digits>, so never a preview (p<port>--<name>--<handle>). Its own origin: the
// grid sets no cookie there, and the app can't reach the user's wisp or the grid's sign-in.
//
// Its database, when its wisp-app.json asks for one (shared/app-db.ts): <data>/sites/<id>.sqlite,
// one for everyone who opens the link, kept across updates, gone when it's unpublished.
//
// Files: <data>/sites/<id>/. A new version is unpacked beside it and swapped in, so a visitor never
// sees half of one. wisp keyed it by its item in My Stuff, so publishing the same app again updates
// the same link. wisp leaves secrets out before it sends, but a link is public and a client can be
// old or anything: here too they're dropped on receipt, and serve opens no dotfile, kept or from an
// older version. All of it runs on a request, so all of it is async.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad, codeOf } from './errors.ts';
import type { CountRow, SiteRow, UserRow } from './rows.ts';
import { createAppDb, dbSpec } from './shared/app-db.ts';
import { appFile, seedOf, serveDb, typeOf } from './shared/apps.ts';
import { privateFile, publicFile, unpackTo } from './shared/bundle.ts';

export const SITE_DEFAULTS = { enabled: true, maxBytes: 50 * 1024 * 1024, perUser: 20, dbBytes: 10 * 1024 * 1024 };
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const SITE_LABEL = /^([a-z0-9-]+)--app--([a-z0-9-]+)$/;

/** "My Slides!" → "my-slides": a DNS label part, never a preview's p<port>. */
export function siteSlug(title: unknown): string {
  const s =
    String(title || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'app';
  return /^p\d+$/.test(s) ? `${s}-app` : s;
}

export interface SiteView {
  key: string;
  title: string;
  url: string;
  files: number;
  size: number;
  createdAt: number;
  updatedAt: number;
}

const exists = (p: string): Promise<boolean> => fs.promises.stat(p).then(
  () => true,
  () => false,
);
const rmrf = (p: string): Promise<void> => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// On Windows a file a visitor just read can stay open a moment after the answer went out
// (EPERM, EBUSY), and a folder with an open file can't be renamed: wait and try again.
async function rename(from: string, to: string): Promise<void> {
  for (let k = 0; ; k++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      if (k >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(codeOf(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * (k + 1)));
    }
  }
}

// A file a visitor may open, as appFile finds it: the check goes on what it resolved to.
async function visible(dir: string, pathname: string, entry: string): Promise<string | null> {
  const file = await appFile(dir, pathname, entry);
  return file && publicFile(path.relative(dir, file)) ? file : null;
}

// Its database: what its own wisp-app.json says, read here rather than taken from the request.
async function dbSeedIn(dir: string): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, 'wisp-app.json'), 'utf8'));
    const names = new Set(await fs.promises.readdir(dir));
    return dbSpec(manifest, (f) => names.has(f))?.seed ?? null;
  } catch {
    return null;
  }
}

type Opts = typeof SITE_DEFAULTS;

export function createSites({ db, cfg, log = () => {} }: { db: Db; cfg: GridConfig; log?: (m: string) => void }) {
  const opts = { ...SITE_DEFAULTS, ...(cfg.sites || {}) } as Opts;
  const root = path.join(cfg.dataDir, 'sites');
  const dirOf = (id: string): string => path.join(root, id);
  const dataOf = (id: string): string => path.join(root, `${id}.sqlite`);
  const appDb = createAppDb({ maxBytes: opts.dbBytes });
  const dropData = async (id: string): Promise<void> => {
    await appDb.release(dataOf(id)).catch(() => {});
    await Promise.all(['', '-wal', '-shm'].map((f) => fs.promises.rm(`${dataOf(id)}${f}`, { force: true })));
  };
  const urlOf = (s: SiteRow): string => `${cfg.instanceUrl(s.label)}/`;
  const view = (s: SiteRow): SiteView => ({ key: s.key, title: s.title, url: urlOf(s), files: s.files, size: s.size, createdAt: s.created_at, updatedAt: s.updated_at });

  const byLabel = (label: unknown): SiteRow | null => {
    if (!SITE_LABEL.test(String(label || ''))) return null;
    return db.get<SiteRow>('SELECT * FROM sites WHERE label = ?', String(label).toLowerCase()) || null;
  };
  const list = (userId: string): SiteRow[] => db.all<SiteRow>('SELECT * FROM sites WHERE user_id = ? ORDER BY updated_at DESC', userId);
  const own = (userId: string, key: string): SiteRow | undefined => db.get<SiteRow>('SELECT * FROM sites WHERE user_id = ? AND key = ?', userId, String(key));

  // Unpacked beside it, secrets dropped on receipt; refused without its entry page.
  async function unpack(id: string, buf: Buffer, start: string): Promise<{ tmp: string; files: number; size: number }> {
    const tmp = path.join(root, `${id}.new-${randomBytes(3).toString('hex')}`);
    let got: { files: number; size: number };
    try {
      got = await unpackTo(buf, tmp, { skip: privateFile });
    } catch (err) {
      await rmrf(tmp);
      throw bad((err as Error).message);
    }
    if (!got.files || !(await visible(tmp, '/', start))) {
      await rmrf(tmp);
      throw bad(`No ${start} in the app.`);
    }
    return { tmp, ...got };
  }

  // Swap it in: the old version moves aside, the new one takes its name, the old one goes.
  async function swapIn(id: string, tmp: string): Promise<void> {
    const dir = dirOf(id);
    const old = `${dir}.old-${randomBytes(3).toString('hex')}`;
    if (await exists(dir)) await rename(dir, old);
    try {
      await rename(tmp, dir);
    } catch (err) {
      if (await exists(old)) await fs.promises.rename(old, dir);
      await rmrf(tmp);
      throw err;
    }
    rmrf(old).catch(() => {});
  }

  /** Publish (or update) the app keyed `key` from a bundle (shared/bundle.ts). */
  async function publish(user: Pick<UserRow, 'id' | 'handle'>, key: string, buf: Buffer, { title, entry }: { title?: string | null; entry?: string | null } = {}): Promise<SiteView> {
    if (!opts.enabled) throw bad('This grid doesn’t publish apps.', 403);
    if (!KEY.test(String(key || ''))) throw bad('Bad app key.');
    const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'App';
    const start = String(entry || 'index.html').replace(/^\/+/, '');
    const have = own(user.id, key);
    if (!have && (db.get<CountRow>('SELECT count(*) AS n FROM sites WHERE user_id = ?', user.id)?.n ?? 0) >= opts.perUser) throw bad(`You have ${opts.perUser} published apps, as many as this grid keeps. Unpublish one first.`, 409);
    const id = have?.id || randomBytes(6).toString('hex');
    const got = await unpack(id, buf, start);
    const dbSeed = await dbSeedIn(got.tmp);
    await swapIn(id, got.tmp);
    const t = Date.now();
    if (have) {
      db.run('UPDATE sites SET title = ?, entry = ?, files = ?, size = ?, db = ?, updated_at = ? WHERE id = ?', name, start, got.files, got.size, dbSeed, t, id);
      return view({ ...have, title: name, entry: start, files: got.files, size: got.size, db: dbSeed, updated_at: t });
    }
    const slug = siteSlug(name);
    let label = `${slug}--app--${user.handle}`;
    for (let k = 2; db.get('SELECT 1 FROM sites WHERE label = ?', label); k++) label = `${slug}-${k}--app--${user.handle}`;
    const row: SiteRow = { id, user_id: user.id, key: String(key), label, title: name, entry: start, files: got.files, size: got.size, db: dbSeed, created_at: t, updated_at: t };
    db.run('INSERT INTO sites (id, user_id, key, label, title, entry, files, size, db, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.user_id, row.key, row.label, row.title, row.entry, row.files, row.size, row.db, row.created_at, row.updated_at);
    log(`grid: ${user.handle} published ${label}`);
    return view(row);
  }

  async function remove(userId: string, key: string): Promise<boolean> {
    const s = own(userId, key);
    if (!s) return false;
    db.run('DELETE FROM sites WHERE id = ?', s.id);
    await Promise.all([rmrf(dirOf(s.id)), dropData(s.id)]);
    return true;
  }

  // An account going: its rows go with it (ON DELETE CASCADE), its files here.
  async function removeAll(userId: string): Promise<void> {
    const rows = list(userId);
    db.run('DELETE FROM sites WHERE user_id = ?', userId);
    await Promise.all(rows.flatMap((s) => [rmrf(dirOf(s.id)), dropData(s.id)]));
  }

  // Anyone's request to a published app: its files, read-only, and its database if it has one.
  async function serve(req: IncomingMessage, res: ServerResponse, s: SiteRow): Promise<void> {
    const head = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname.startsWith('/_wisp/')) {
      const spec = s.db !== null && s.db !== undefined ? { seed: s.db } : null;
      return serveDb(req, res, pathname, spec, async () => ({ file: dataOf(s.id), seed: await seedOf(dirOf(s.id), spec, dataOf(s.id)) }), appDb);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...head });
      res.end();
      return;
    }
    const file = await visible(dirOf(s.id), pathname, s.entry);
    const st = file ? await fs.promises.stat(file).catch(() => null) : null;
    if (!file || !st) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...head });
      res.end('Not found in this app.');
      return;
    }
    res.writeHead(200, { 'content-type': typeOf(file), 'content-length': st.size, 'cache-control': 'public, max-age=60', 'last-modified': new Date(s.updated_at).toUTCString(), ...head });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  return { opts, view, list, byLabel, publish, remove, removeAll, serve, close: () => appDb.close() };
}

export type Sites = ReturnType<typeof createSites>;

/** The raw body of a publish, up to max bytes. Too big: refused at once, the rest read and dropped so the answer still reaches wisp. */
export function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(bad(`That app is too big to publish here (${Math.round(max / 1024 / 1024)} MB at most).`, 413));
        chunks.length = 0;
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
