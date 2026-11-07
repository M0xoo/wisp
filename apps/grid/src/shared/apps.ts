// Copy of v1 server/services/apps.js (typeOf, appFile, seedOf, serveDb) and the MIME table of
// server/http/static.js; the grid serves what wisp packed, so the format must match. When the owner
// plugin (stuff) publishes these from its api, import them from there and delete this copy.
// appFile and seedOf are async here (v1's were sync): the grid calls them on every request to a
// published app.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { DB_CLIENT, type AppDb, type DbWhere } from './app-db.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.avif': 'image/avif',
  '.xml': 'application/xml',
};

export const typeOf = (f: string): string => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

const isFile = async (f: string): Promise<boolean> => (await fs.promises.stat(f).catch(() => null))?.isFile() ?? false;

/** A file of the app for a request path: inside its folder only; a folder gives its index.html. */
export async function appFile(root: string, urlPath: string, entry = 'index.html'): Promise<string | null> {
  let p: string;
  try {
    p = decodeURIComponent(String(urlPath).split('?')[0] ?? '');
  } catch {
    return null;
  }
  if (p === '/' || p === '') p = `/${entry}`;
  const file = path.resolve(root, `.${path.posix.normalize(p)}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const st = await fs.promises.stat(file).catch(() => null);
  if (st?.isFile()) return file;
  if (st?.isDirectory() && (await isFile(path.join(file, 'index.html')))) return path.join(file, 'index.html');
  return null;
}

export interface DbSpec {
  seed: string;
}

/** The SQL to make an app's database with: its seed file, read only when there's no database yet. */
export async function seedOf(root: string, db: DbSpec | null, file: string): Promise<string> {
  if (!db?.seed || (await fs.promises.stat(file).catch(() => null))) return '';
  const f = await appFile(root, `/${db.seed}`);
  return f ? fs.promises.readFile(f, 'utf8') : '';
}

/** /_wisp/db.js (the page's helper) and /_wisp/db (its queries), for an app with a database. */
export async function serveDb(req: IncomingMessage, res: ServerResponse, pathname: string, db: DbSpec | null, where: () => Promise<DbWhere>, appDb: AppDb): Promise<void> {
  const head = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (!db) {
    res.writeHead(404, { 'content-type': 'application/json', ...head });
    res.end(JSON.stringify({ error: 'This app has no database: put "db": true in its wisp-app.json.' }));
    return;
  }
  if (pathname === '/_wisp/db.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...head });
    res.end(req.method === 'HEAD' ? undefined : DB_CLIENT);
    return;
  }
  if (pathname === '/_wisp/db') return appDb.handle(req, res, await where());
  res.writeHead(404, { 'content-type': 'application/json', ...head });
  res.end(JSON.stringify({ error: 'not found' }));
}
