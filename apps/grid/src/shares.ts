// Shared tasks: a conversation someone shared from their wisp, kept here so it answers while their
// computer is off. Two ways in:
//
//   the page    <publicUrl>/s/<id>, in any browser: the conversation, read-only. Anyone with the
//               link, or only with its passkey when the sharer set one.
//   import      wisp signed in to this grid (a device token, or the cloud wisp's Box secret) asks
//               GET /api/shares/<id> for the card and GET /api/shares/<id>/pack for the whole
//               thing (the turns, the work, connectors and skills) to carry the task on there.
//
// Files: <data>/shares/<id>/ holds what the sharer packed (shared/bundle.ts): task.json, and
// work.bundle (a git bundle) or files/ (a folder-less task's files). A passkey is kept as an
// scrypt hash, never as it was typed. key: the task's id on the sharer's wisp, so sharing it
// again updates the same link. Everything here runs on a request, so it's async throughout
// (v1's scryptSync and fs *Sync held the event loop for every visitor).

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad } from './errors.ts';
import type { CountRow, ShareRow, UserRow } from './rows.ts';
import { packDir, unpackTo } from './shared/bundle.ts';

export const SHARE_DEFAULTS = { enabled: true, maxBytes: 100 * 1024 * 1024, perUser: 200 };
export const SHARE_ID = /^[A-Za-z0-9_-]{16}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const PASSKEY_MAX = 128;
export const MEDIA_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const MEDIA = new RegExp(`^\\d{1,5}\\.(${Object.keys(MEDIA_TYPES).join('|')})$`);

const scryptAsync = (pass: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(pass, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));

/** A passkey as kept: "<salt>:<hash>", both hex. */
export async function hashPasskey(pass: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await scryptAsync(String(pass), salt)).toString('hex')}`;
}

/** Whether pass opens a share kept with `kept` (none kept: open to anyone with the link). */
export async function checkPasskey(kept: string | null | undefined, pass: unknown): Promise<boolean> {
  if (!kept) return true;
  const [salt, hash] = String(kept).split(':');
  if (!salt || !hash || typeof pass !== 'string' || !pass) return false;
  const want = Buffer.from(hash, 'hex');
  const got = await scryptAsync(pass, Buffer.from(salt, 'hex'));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** task.json as the sharer's wisp wrote it: read loosely, every field checked where it's used. */
export type SharedTask = Record<string, unknown> & { wispTask?: unknown; turns?: unknown; runs?: Record<string, unknown> };

export interface ShareMeta {
  title: string;
  agent: string;
  model: string;
  effort: string;
  mode: string;
  turns: number;
  lastAt: number | null;
  work: { kind: 'files' | 'git'; repo: string; branch: string; changed: number } | null;
  connectors: string[];
  skills: string[];
  team: number;
  delegates: number;
  crew: string[];
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cut = (v: unknown, n: number): string => String(v ?? '').slice(0, n);
const names = (v: unknown, field: string, n: number, max: number): string[] =>
  arr(v)
    .map((x) => cut(obj(x)?.[field], n))
    .filter(Boolean)
    .slice(0, max);

/** task.json → what the card and the page say about it before anyone imports it. */
export function shareMeta(task: unknown): ShareMeta {
  const t = obj(task) ?? {};
  const turns = arr(t['turns']);
  const last = obj(turns[turns.length - 1]);
  const w = obj(t['work']);
  return {
    title: cut(t['title'], 200) || 'Shared task',
    agent: cut(t['agent'], 30),
    model: cut(t['model'], 120),
    effort: cut(t['effort'], 20),
    mode: cut(t['mode'], 10),
    turns: turns.length,
    lastAt: Number(last?.['endedAt'] || last?.['startedAt']) || null,
    work: w ? { kind: w['kind'] === 'files' ? 'files' : 'git', repo: cut(w['repo'], 300), branch: cut(w['branch'], 120), changed: Number(w['changed']) || 0 } : null,
    connectors: names(t['connectors'], 'name', 40, 40),
    skills: names(t['kit'], 'name', 64, 40),
    team: arr(t['subagents']).length,
    delegates: obj(t['runs']) ? Object.keys(obj(t['runs']) ?? {}).length : 0,
    crew: names(obj(t['crew'])?.['members'], 'name', 24, 20),
  };
}

export interface ShareView {
  id: string;
  key: string;
  url: string;
  title: string;
  locked: boolean;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export type ShareCard = Partial<ShareMeta> & {
  id: string;
  url: string;
  locked: boolean;
  from: { handle: string; name: string; avatar: string } | null;
  createdAt: number;
  updatedAt: number;
};

type Opts = typeof SHARE_DEFAULTS;

export function createShares({ db, cfg, log = () => {} }: { db: Db; cfg: GridConfig; log?: (m: string) => void }) {
  const opts: Opts = { ...SHARE_DEFAULTS, ...(cfg.shares || {}) } as Opts;
  const root = path.join(cfg.dataDir, 'shares');
  const dirOf = (id: string): string => path.join(root, id);
  const urlOf = (s: Pick<ShareRow, 'id'>): string => `${cfg.publicUrl}/s/${s.id}`;
  const metaOf = (s: ShareRow): Partial<ShareMeta> => {
    try {
      return (obj(JSON.parse(s.meta)) ?? {}) as Partial<ShareMeta>;
    } catch {
      return {};
    }
  };
  // What the sharer's wisp sees: the link and whether it's locked, never the passkey.
  const view = (s: ShareRow): ShareView => ({ id: s.id, key: s.key, url: urlOf(s), title: s.title, locked: !!s.pass, size: s.size, createdAt: s.created_at, updatedAt: s.updated_at });
  // What someone opening it sees: who shared it, and what it carries.
  const card = (s: ShareRow, user: UserRow | null | undefined): ShareCard => ({ id: s.id, url: urlOf(s), locked: !!s.pass, from: user ? { handle: user.handle, name: user.name || user.handle, avatar: user.avatar || '' } : null, ...metaOf(s), createdAt: s.created_at, updatedAt: s.updated_at });

  const get = (id: unknown): ShareRow | null => (SHARE_ID.test(String(id || '')) ? db.get<ShareRow>('SELECT * FROM shares WHERE id = ?', String(id)) || null : null);
  const own = (userId: string, key: string): ShareRow | undefined => db.get<ShareRow>('SELECT * FROM shares WHERE user_id = ? AND key = ?', userId, String(key));
  const list = (userId: string): ShareRow[] => db.all<ShareRow>('SELECT * FROM shares WHERE user_id = ? ORDER BY updated_at DESC', userId);
  const rmrf = (p: string): Promise<void> => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  // Unpacked beside the old one and swapped in, so a visitor never reads half of each.
  async function unpackTask(id: string, buf: Buffer): Promise<SharedTask> {
    const tmp = path.join(root, `${id}.new-${randomBytes(3).toString('hex')}`);
    let task: SharedTask;
    try {
      await unpackTo(buf, tmp);
      task = (obj(JSON.parse(await fs.promises.readFile(path.join(tmp, 'task.json'), 'utf8'))) ?? {}) as SharedTask;
      if (task.wispTask !== 1 || !Array.isArray(task.turns)) throw new Error('not a shared task');
    } catch (err) {
      await rmrf(tmp);
      throw bad(`That isn’t a task wisp can share: ${(err as Error).message}`);
    }
    const dir = dirOf(id);
    const old = `${dir}.old-${randomBytes(3).toString('hex')}`;
    const had = await fs.promises.rename(dir, old).then(
      () => true,
      () => false,
    );
    await fs.promises.rename(tmp, dir);
    if (had) await rmrf(old);
    return task;
  }

  // Share (or update) the task keyed `key` from a bundle. passkey: '' for anyone with the link,
  // a string to lock it, undefined to keep what it had.
  async function share(user: Pick<UserRow, 'id' | 'handle'>, key: string, buf: Buffer, { passkey }: { passkey?: string | undefined } = {}): Promise<ShareView> {
    if (!opts.enabled) throw bad('This grid doesn’t share tasks.', 403);
    if (!KEY.test(String(key || ''))) throw bad('Bad task key.');
    if (typeof passkey === 'string' && passkey.length > PASSKEY_MAX) throw bad(`A passkey is at most ${PASSKEY_MAX} characters.`);
    const have = own(user.id, key);
    if (!have && (db.get<CountRow>('SELECT count(*) AS n FROM shares WHERE user_id = ?', user.id)?.n ?? 0) >= opts.perUser) throw bad(`You have ${opts.perUser} shared tasks, as many as this grid keeps. Stop sharing one first.`, 409);
    const id = have?.id || randomBytes(12).toString('base64url');
    const meta = shareMeta(await unpackTask(id, buf));
    const pass = passkey === undefined ? have?.pass || null : passkey ? await hashPasskey(passkey) : null;
    const t = Date.now();
    const row: ShareRow = { id, user_id: user.id, key: String(key), title: meta.title, pass, size: buf.length, meta: JSON.stringify(meta), created_at: have?.created_at || t, updated_at: t };
    if (have) db.run('UPDATE shares SET title = ?, pass = ?, size = ?, meta = ?, updated_at = ? WHERE id = ?', row.title, row.pass, row.size, row.meta, t, id);
    else {
      db.run('INSERT INTO shares (id, user_id, key, title, pass, size, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.user_id, row.key, row.title, row.pass, row.size, row.meta, row.created_at, row.updated_at);
      log(`grid: ${user.handle} shared a task`);
    }
    return view(row);
  }

  async function remove(userId: string, key: string): Promise<boolean> {
    const s = own(userId, key);
    if (!s) return false;
    db.run('DELETE FROM shares WHERE id = ?', s.id);
    await rmrf(dirOf(s.id));
    return true;
  }

  async function removeAll(userId: string): Promise<void> {
    const rows = list(userId);
    db.run('DELETE FROM shares WHERE user_id = ?', userId);
    await Promise.all(rows.map((s) => rmrf(dirOf(s.id))));
  }

  // The conversation, for the page: task.json as it was shared.
  const task = async (s: ShareRow): Promise<SharedTask> => (obj(JSON.parse(await fs.promises.readFile(path.join(dirOf(s.id), 'task.json'), 'utf8'))) ?? {}) as SharedTask;
  // A picture or video its reports show (media/<n>.<ext>), for the page: its path, or null.
  const media = async (s: ShareRow, name: string): Promise<string | null> => {
    if (!MEDIA.test(String(name || ''))) return null;
    const p = path.join(dirOf(s.id), 'media', name);
    return (await fs.promises.stat(p).catch(() => null))?.isFile() ? p : null;
  };
  // Everything, for an import: the folder packed again.
  const pack = async (s: ShareRow): Promise<Buffer> => (await packDir(dirOf(s.id))).body;
  const unlocks = (s: ShareRow, pass: unknown): Promise<boolean> => checkPasskey(s.pass, pass);

  return { opts, get, own, list, view, card, share, remove, removeAll, task, media, pack, unlocks };
}

export type Shares = ReturnType<typeof createShares>;
