// Published apps: an app from someone's My Stuff (static files: HTML, JS, CSS), put on the grid so
// anyone with the link can open it. It lives here, not in their box, so it answers while their
// wisp sleeps and their computers are off.
//
// Address: <slug>--app--<handle>.<domain>. Three parts, so never a computer (<name>--<handle>), and
// a slug is never p<digits>, so never a preview (p<port>--<name>--<handle>). Its own origin: the
// grid sets no cookie there, and the app can't reach the user's wisp or the grid's sign-in.
//
// Its database, when its wisp-app.json asks for one (server/app-db.js): <data>/sites/<id>.sqlite,
// one for everyone who opens the link, kept across updates, gone when it's unpublished.
//
// Files: <data>/sites/<id>/. A new version is unpacked beside it and swapped in, so a visitor never
// sees half of one. wisp on a computer or in a box sends it (server/services/publish.js), keyed by
// its item in My Stuff, so publishing the same app again updates the same link.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appFile, seedOf, serveDb, typeOf } from '../server/services/apps.js';
import { createAppDb, dbSpec } from '../server/app-db.js';
import { unpackTo } from '../server/bundle.js';
import { bad } from './accounts.js';

export const SITE_DEFAULTS = { enabled: true, maxBytes: 50 * 1024 * 1024, perUser: 20, dbBytes: 10 * 1024 * 1024 };
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const SITE_LABEL = /^([a-z0-9-]+)--app--([a-z0-9-]+)$/;

// "My Slides!" → "my-slides": a DNS label part, never a preview's p<port>.
export function siteSlug(title) {
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

export function createSites({ db, cfg, log = () => {} }) {
  const opts = { ...SITE_DEFAULTS, ...(cfg.sites || {}) };
  const root = path.join(cfg.dataDir, 'sites');
  const dirOf = (id) => path.join(root, id);
  const dataOf = (id) => path.join(root, `${id}.sqlite`);
  const appDb = createAppDb({ maxBytes: opts.dbBytes });
  const dropData = async (id) => {
    await appDb.release(dataOf(id)).catch(() => {});
    for (const f of ['', '-wal', '-shm']) fs.rmSync(`${dataOf(id)}${f}`, { force: true });
  };
  const urlOf = (s) => `${cfg.instanceUrl(s.label)}/`;
  // On Windows a file a visitor just read can stay open a moment after the answer went out
  // (EPERM, EBUSY), and a folder with an open file can't be renamed: wait and try again.
  const rename = async (from, to) => {
    for (let k = 0; ; k++) {
      try {
        return fs.renameSync(from, to);
      } catch (err) {
        if (k >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 50 * (k + 1)));
      }
    }
  };
  const view = (s) => ({ key: s.key, title: s.title, url: urlOf(s), files: s.files, size: s.size, createdAt: s.created_at, updatedAt: s.updated_at });

  const byLabel = (label) => {
    if (!SITE_LABEL.test(String(label || ''))) return null;
    return db.get('SELECT * FROM sites WHERE label = ?', String(label).toLowerCase()) || null;
  };
  const list = (userId) => db.all('SELECT * FROM sites WHERE user_id = ? ORDER BY updated_at DESC', userId);
  const own = (userId, key) => db.get('SELECT * FROM sites WHERE user_id = ? AND key = ?', userId, String(key));

  // Publish (or update) the app keyed `key` from a bundle (server/bundle.js).
  async function publish(user, key, buf, { title, entry } = {}) {
    if (!opts.enabled) throw bad('This grid doesn’t publish apps.', 403);
    if (!KEY.test(String(key || ''))) throw bad('Bad app key.');
    const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'App';
    const start = String(entry || 'index.html').replace(/^\/+/, '');
    const have = own(user.id, key);
    if (!have && db.get('SELECT count(*) AS n FROM sites WHERE user_id = ?', user.id).n >= opts.perUser) throw bad(`You have ${opts.perUser} published apps, as many as this grid keeps. Unpublish one first.`, 409);
    const id = have?.id || randomBytes(6).toString('hex');
    const tmp = path.join(root, `${id}.new-${randomBytes(3).toString('hex')}`);
    let got;
    try {
      got = unpackTo(buf, tmp);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw bad(err.message);
    }
    if (!got.files || !appFile(tmp, '/', start)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw bad(`No ${start} in the app.`);
    }
    // Its database: what its own wisp-app.json says, read here rather than taken from the request.
    let dbSeed = null;
    try {
      const spec = dbSpec(JSON.parse(fs.readFileSync(path.join(tmp, 'wisp-app.json'), 'utf8')), (f) => fs.existsSync(path.join(tmp, f)));
      if (spec) dbSeed = spec.seed;
    } catch {}
    // Swap it in: the old version moves aside, the new one takes its name, the old one goes.
    const dir = dirOf(id);
    const old = `${dir}.old-${randomBytes(3).toString('hex')}`;
    if (fs.existsSync(dir)) await rename(dir, old);
    try {
      await rename(tmp, dir);
    } catch (err) {
      if (fs.existsSync(old)) fs.renameSync(old, dir);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    fs.promises.rm(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    const t = Date.now();
    if (have) {
      db.run('UPDATE sites SET title = ?, entry = ?, files = ?, size = ?, db = ?, updated_at = ? WHERE id = ?', name, start, got.files, got.size, dbSeed, t, id);
      return view({ ...have, title: name, entry: start, files: got.files, size: got.size, db: dbSeed, updated_at: t });
    }
    const slug = siteSlug(name);
    let label = `${slug}--app--${user.handle}`;
    for (let k = 2; db.get('SELECT 1 FROM sites WHERE label = ?', label); k++) label = `${slug}-${k}--app--${user.handle}`;
    const row = { id, user_id: user.id, key: String(key), label, title: name, entry: start, files: got.files, size: got.size, db: dbSeed, created_at: t, updated_at: t };
    db.run('INSERT INTO sites (id, user_id, key, label, title, entry, files, size, db, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...Object.values(row));
    log(`grid: ${user.handle} published ${label}`);
    return view(row);
  }

  function remove(userId, key) {
    const s = own(userId, key);
    if (!s) return false;
    db.run('DELETE FROM sites WHERE id = ?', s.id);
    fs.rmSync(dirOf(s.id), { recursive: true, force: true });
    dropData(s.id);
    return true;
  }

  // An account going: its rows go with it (ON DELETE CASCADE), its files here.
  function removeAll(userId) {
    for (const s of list(userId)) {
      fs.rmSync(dirOf(s.id), { recursive: true, force: true });
      dropData(s.id);
    }
    db.run('DELETE FROM sites WHERE user_id = ?', userId);
  }

  // Anyone's request to a published app: its files, read-only, and its database if it has one.
  function serve(req, res, s) {
    const head = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname.startsWith('/_wisp/')) return serveDb(req, res, pathname, s.db !== null && s.db !== undefined && { seed: s.db }, () => ({ file: dataOf(s.id), seed: seedOf(dirOf(s.id), { seed: s.db }, dataOf(s.id)) }), appDb);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', ...head });
      return res.end();
    }
    const file = appFile(dirOf(s.id), new URL(req.url, 'http://x').pathname, s.entry);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...head });
      return res.end('Not found in this app.');
    }
    const st = fs.statSync(file);
    res.writeHead(200, { 'content-type': typeOf(file), 'content-length': st.size, 'cache-control': 'public, max-age=60', 'last-modified': new Date(s.updated_at).toUTCString(), ...head });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  return { opts, view, list, byLabel, publish, remove, removeAll, serve, close: () => appDb.close() };
}

// The raw body of a publish, up to max bytes.
export function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Too big: refused at once, the rest read and dropped so the answer still reaches wisp.
    req.on('data', (c) => {
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
