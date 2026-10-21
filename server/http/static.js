// The web UI: files under web/, with index.html for every other path (the app routes itself).
//
// The phone app loads this page through an SSH tunnel, where every round trip and every byte is
// slow, so files are kept in memory (re-read when they change on disk), gzipped once, and
// revalidated by ETag (a 304 instead of the file). index.html also preloads every module app.js
// imports, so the browser fetches them in parallel instead of one import level at a time, and
// names the build (x-wisp-build) so the phone's service worker (web/sw.js) can tell when its cached
// copy is out of date.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const INDEX = path.join(WEB, 'index.html');
const ENTRY = path.join(WEB, 'js', 'app.js');

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
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.md']);
const MAX_CACHED = 4e6; // bigger files (videos) are streamed, not held in memory

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20);

// path -> { mtimeMs, size, body, gz, etag }. Keyed on the file's stat, so an edit shows at once.
const files = new Map();
function read(p) {
  const st = fs.statSync(p);
  const f = files.get(p);
  if (f && f.mtimeMs === st.mtimeMs && f.size === st.size) return f;
  const body = fs.readFileSync(p);
  const ext = path.extname(p);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag: `"${hash(body)}"`, gz: TEXT.has(ext) && body.length > 1024 ? zlib.gzipSync(body) : null };
  files.set(p, entry);
  return entry;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// The modules app.js loads before it runs: its static imports, and theirs. Dynamic import()s are
// left out (they load when used).
const IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?['"](\.{1,2}\/[^'"]+\.js)['"]/g;
export function moduleGraph(entry = ENTRY) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const src = read(file).body.toString();
    for (const [, rel] of src.matchAll(IMPORT)) {
      const p = path.join(path.dirname(file), rel);
      if (seen.has(p) || !p.startsWith(WEB + path.sep) || !isFile(p)) continue;
      seen.add(p);
      queue.push(p);
    }
  }
  return [...seen].map((p) => '/' + path.relative(WEB, p).split(path.sep).join('/'));
}

// index.html with the preloads, and the build: a hash of every file under web/, so two computers
// on the same wisp version agree on it (the phone reaches both through one origin).
let page = null;
function index() {
  const build = hash(webFiles().map((p) => read(p).etag).join());
  if (page?.build === build) return page;
  const links = moduleGraph().map((u) => `  <link rel="modulepreload" href="${u}">`);
  const head = [`  <meta name="wisp-build" content="${build}">`, ...links].join('\n');
  const body = Buffer.from(read(INDEX).body.toString().replace('</head>', `${head}\n</head>`));
  page = { build, body, etag: `"${build}"`, gz: zlib.gzipSync(body) };
  return page;
}
function webFiles(dir = WEB) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return webFiles(p);
      return d.isFile() && fs.statSync(p).size <= MAX_CACHED ? [p] : [];
    });
}

export function serveStatic(req, res, pathname) {
  const p = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
  // Inside web/ only: a sibling folder whose name starts with "web" doesn't count. Anything else
  // is the SPA fallback.
  const file = p.startsWith(WEB + path.sep) && p !== INDEX && isFile(p) ? p : null;
  const ext = file ? path.extname(file) : '.html';
  if (file && fs.statSync(file).size > MAX_CACHED) {
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  const f = file ? read(file) : index();
  // no-cache: the browser keeps the file but asks first, and an unchanged one costs a 304.
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache', etag: f.etag };
  if (!file) headers['x-wisp-build'] = f.build;
  if (f.gz) headers.vary = 'accept-encoding';
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gzip = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) headers['content-encoding'] = 'gzip';
  const body = gzip ? f.gz : f.body;
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
