// Content types by extension: v1's server/http/static.js MIME table (what My Stuff and uploads
// used), and the longer list an app's own server answers with (v1 services/apps.js).
import path from 'node:path';

export const MIME: Readonly<Record<string, string>> = {
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
};

const MORE_MIME: Readonly<Record<string, string>> = {
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
  '.webmanifest': 'application/manifest+json',
};

/** An app's file's type, as its own server answers it. */
export const typeOf = (f: string): string => {
  const ext = path.extname(f).toLowerCase();
  return MORE_MIME[ext] ?? MIME[ext] ?? 'application/octet-stream';
};
