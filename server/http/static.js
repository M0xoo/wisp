// The web UI: files under web/, with index.html for every other path (the app routes itself).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export const MIME = {
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
  '.pdf': 'application/pdf',
};

export function serveStatic(res, pathname) {
  const p = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
  if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    // SPA fallback
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return fs.createReadStream(path.join(WEB, 'index.html')).pipe(res);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
}
