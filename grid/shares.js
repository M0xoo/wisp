// Shared tasks: a conversation someone shared from their wisp (server/services/share.js), kept here
// so it answers while their computer is off. Two ways in:
//
//   the page    <publicUrl>/s/<id>, in any browser: the conversation, read-only. Anyone with the
//               link, or only with its passkey when the sharer set one.
//   import      wisp signed in to this grid (a device token, or the cloud wisp's Box secret) asks
//               GET /api/shares/<id> for the card and GET /api/shares/<id>/pack for the whole
//               thing (the turns, the work, connectors and skills) to carry the task on there.
//
// Files: <data>/shares/<id>/ holds what the sharer packed (server/bundle.js): task.json, and
// work.bundle (a git bundle) or files/ (a folder-less task's files). A passkey is kept as an
// scrypt hash, never as it was typed. key: the task's id on the sharer's wisp, so sharing it
// again updates the same link.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { packDir, unpackTo } from '../server/bundle.js';
import { bad } from './accounts.js';

export const SHARE_DEFAULTS = { enabled: true, maxBytes: 100 * 1024 * 1024, perUser: 200 };
export const SHARE_ID = /^[A-Za-z0-9_-]{16}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const PASSKEY_MAX = 128;
export const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const MEDIA = new RegExp(`^\\d{1,5}\\.(${Object.keys(MEDIA_TYPES).join('|')})$`);

// A passkey as kept: "<salt>:<hash>", both hex.
export function hashPasskey(pass) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(String(pass), salt, 32).toString('hex')}`;
}
export function checkPasskey(kept, pass) {
  if (!kept) return true;
  const [salt, hash] = String(kept).split(':');
  if (!salt || !hash || typeof pass !== 'string' || !pass) return false;
  const want = Buffer.from(hash, 'hex');
  const got = scryptSync(pass, Buffer.from(salt, 'hex'), 32);
  return got.length === want.length && timingSafeEqual(got, want);
}

// task.json → what the card and the page say about it before anyone imports it.
export function shareMeta(task) {
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  const str = (v, n) => String(v ?? '').slice(0, n);
  const w = task?.work && typeof task.work === 'object' ? task.work : null;
  return {
    title: str(task?.title, 200) || 'Shared task',
    agent: str(task?.agent, 30),
    model: str(task?.model, 120),
    effort: str(task?.effort, 20),
    mode: str(task?.mode, 10),
    turns: turns.length,
    lastAt: Number(turns.at(-1)?.endedAt || turns.at(-1)?.startedAt) || null,
    work: w ? { kind: w.kind === 'files' ? 'files' : 'git', repo: str(w.repo, 300), branch: str(w.branch, 120), changed: Number(w.changed) || 0 } : null,
    connectors: (Array.isArray(task?.connectors) ? task.connectors : []).map((c) => str(c?.name, 40)).filter(Boolean).slice(0, 40),
    skills: (Array.isArray(task?.kit) ? task.kit : []).map((k) => str(k?.name, 64)).filter(Boolean).slice(0, 40),
    team: (Array.isArray(task?.subagents) ? task.subagents : []).length,
    delegates: task?.runs && typeof task.runs === 'object' ? Object.keys(task.runs).length : 0,
    crew: (Array.isArray(task?.crew?.members) ? task.crew.members : []).map((m) => str(m?.name, 24)).filter(Boolean).slice(0, 20),
  };
}

export function createShares({ db, cfg, log = () => {} }) {
  const opts = { ...SHARE_DEFAULTS, ...(cfg.shares || {}) };
  const root = path.join(cfg.dataDir, 'shares');
  const dirOf = (id) => path.join(root, id);
  const urlOf = (s) => `${cfg.publicUrl}/s/${s.id}`;
  const metaOf = (s) => {
    try {
      return JSON.parse(s.meta);
    } catch {
      return {};
    }
  };
  // What the sharer's wisp sees: the link and whether it's locked, never the passkey.
  const view = (s) => ({ id: s.id, key: s.key, url: urlOf(s), title: s.title, locked: !!s.pass, size: s.size, createdAt: s.created_at, updatedAt: s.updated_at });
  // What someone opening it sees: who shared it, and what it carries.
  const card = (s, user) => ({ id: s.id, url: urlOf(s), locked: !!s.pass, from: user ? { handle: user.handle, name: user.name || user.handle, avatar: user.avatar || '' } : null, ...metaOf(s), createdAt: s.created_at, updatedAt: s.updated_at });

  const get = (id) => (SHARE_ID.test(String(id || '')) ? db.get('SELECT * FROM shares WHERE id = ?', String(id)) || null : null);
  const own = (userId, key) => db.get('SELECT * FROM shares WHERE user_id = ? AND key = ?', userId, String(key));
  const list = (userId) => db.all('SELECT * FROM shares WHERE user_id = ? ORDER BY updated_at DESC', userId);

  // Share (or update) the task keyed `key` from a bundle. passkey: '' for anyone with the link,
  // a string to lock it, undefined to keep what it had.
  function share(user, key, buf, { passkey } = {}) {
    if (!opts.enabled) throw bad('This grid doesn’t share tasks.', 403);
    if (!KEY.test(String(key || ''))) throw bad('Bad task key.');
    if (typeof passkey === 'string' && passkey.length > PASSKEY_MAX) throw bad(`A passkey is at most ${PASSKEY_MAX} characters.`);
    const have = own(user.id, key);
    if (!have && db.get('SELECT count(*) AS n FROM shares WHERE user_id = ?', user.id).n >= opts.perUser) throw bad(`You have ${opts.perUser} shared tasks, as many as this grid keeps. Stop sharing one first.`, 409);
    const id = have?.id || randomBytes(12).toString('base64url');
    const tmp = path.join(root, `${id}.new-${randomBytes(3).toString('hex')}`);
    let task;
    try {
      unpackTo(buf, tmp);
      task = JSON.parse(fs.readFileSync(path.join(tmp, 'task.json'), 'utf8'));
      if (task?.wispTask !== 1 || !Array.isArray(task.turns)) throw new Error('not a shared task');
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw bad(`That isn’t a task wisp can share: ${err.message}`);
    }
    const dir = dirOf(id);
    const old = `${dir}.old-${randomBytes(3).toString('hex')}`;
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    fs.renameSync(tmp, dir);
    fs.rmSync(old, { recursive: true, force: true });
    const meta = shareMeta(task);
    const pass = passkey === undefined ? have?.pass || null : passkey ? hashPasskey(passkey) : null;
    const t = Date.now();
    const row = { id, user_id: user.id, key: String(key), title: meta.title, pass, size: buf.length, meta: JSON.stringify(meta), created_at: have?.created_at || t, updated_at: t };
    if (have) db.run('UPDATE shares SET title = ?, pass = ?, size = ?, meta = ?, updated_at = ? WHERE id = ?', row.title, row.pass, row.size, row.meta, t, id);
    else {
      db.run('INSERT INTO shares (id, user_id, key, title, pass, size, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...Object.values(row));
      log(`grid: ${user.handle} shared a task`);
    }
    return view(row);
  }

  function remove(userId, key) {
    const s = own(userId, key);
    if (!s) return false;
    db.run('DELETE FROM shares WHERE id = ?', s.id);
    fs.rmSync(dirOf(s.id), { recursive: true, force: true });
    return true;
  }

  function removeAll(userId) {
    for (const s of list(userId)) fs.rmSync(dirOf(s.id), { recursive: true, force: true });
    db.run('DELETE FROM shares WHERE user_id = ?', userId);
  }

  // The conversation, for the page: task.json as it was shared.
  const task = (s) => JSON.parse(fs.readFileSync(path.join(dirOf(s.id), 'task.json'), 'utf8'));
  // A picture or video its reports show (media/<n>.<ext>, server/services/share.js packAttached),
  // for the page: its path, or null.
  const media = (s, name) => {
    if (!MEDIA.test(String(name || ''))) return null;
    const p = path.join(dirOf(s.id), 'media', name);
    return fs.existsSync(p) ? p : null;
  };
  // Everything, for an import: the folder packed again.
  const pack = (s) => packDir(dirOf(s.id)).body;

  return { opts, get, own, list, view, card, share, remove, removeAll, task, media, pack, unlocks: (s, pass) => checkPasskey(s.pass, pass) };
}
