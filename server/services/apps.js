// Apps in My Stuff (services/stuff.js): a folder of static files an agent built (slides, a demo, a
// small tool), served on a port of its own on 127.0.0.1 while it's launched. Its own origin, not
// wisp's: its scripts, storage and fetches work like any site's, and wisp's API stays out of its
// reach (no CORS, and the Origin check refuses its writes). The port comes from the item's id, so
// the app keeps its storage between launches. On a wisp Grid the page opens it at the preview
// address that port has (server/http/preview.js).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MIME } from '../http/static.js';
import { bad } from '../util.js';

const BASE = 47100;
const SPAN = 800;
const IDLE_MS = 30 * 60_000; // stopped half an hour after its last request
const MAX_RUNNING = 8;
const MORE_MIME = {
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
const typeOf = (f) => MORE_MIME[path.extname(f).toLowerCase()] || MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

// The same port for the same app every time (its localStorage lives on its origin).
export function appPort(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BASE + (h % SPAN);
}

// A file of the app for a request path: inside its folder only; a folder gives its index.html.
export function appFile(root, urlPath, entry = 'index.html') {
  let p;
  try {
    p = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null;
  }
  if (p === '/' || p === '') p = `/${entry}`;
  const file = path.resolve(root, `.${path.posix.normalize(p)}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return file;
    if (st.isDirectory() && fs.existsSync(path.join(file, 'index.html'))) return path.join(file, 'index.html');
  } catch {}
  return null;
}

export class Apps {
  constructor({ stuff, onChange = () => {} }) {
    this.stuff = stuff;
    this.onChange = onChange;
    this.running = new Map(); // id -> { server, port, last, timer }
  }

  state(id) {
    const r = this.running.get(id);
    return r ? { port: r.port } : null;
  }

  // Start it (or keep it going): resolves to its port.
  async launch(id) {
    const it = this.stuff.get(id);
    if (!it || it.kind !== 'app') throw bad('That’s not an app in My Stuff.', 404);
    const on = this.running.get(id);
    if (on && on.root === it.path) {
      on.last = Date.now();
      return on.port;
    }
    if (on) this.stop(id, { quiet: true }); // updated since: serve the new folder
    if (this.running.size >= MAX_RUNNING) {
      const oldest = [...this.running.entries()].sort((a, b) => a[1].last - b[1].last)[0];
      this.stop(oldest[0], { quiet: true });
    }
    const root = it.path;
    const r = { root, port: 0, last: Date.now(), server: null, timer: null };
    r.server = http.createServer((req, res) => this.#serve(r, it.entry, req, res));
    const want = appPort(id);
    for (let i = 0; i < 20 && !r.port; i++) {
      const port = BASE + ((want - BASE + i * 7) % SPAN);
      r.port = await new Promise((resolve) => {
        r.server.once('error', () => resolve(0));
        r.server.listen(port, '127.0.0.1', () => resolve(port));
      });
    }
    if (!r.port) throw bad('No free port to start the app on.', 503);
    r.timer = setInterval(() => Date.now() - r.last > IDLE_MS && this.stop(id), 60_000);
    r.timer.unref();
    this.running.set(id, r);
    this.onChange();
    return r.port;
  }

  #serve(r, entry, req, res) {
    r.last = Date.now();
    // Only by its loopback name (a preview through the grid comes as localhost too): a page on
    // another site can't reach it through a rebound DNS name.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden host');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    const file = appFile(r.root, new URL(req.url, 'http://x').pathname, entry);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found in this app.');
    }
    const st = fs.statSync(file);
    res.writeHead(200, { 'content-type': typeOf(file), 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  stop(id, { quiet = false } = {}) {
    const r = this.running.get(id);
    if (!r) return false;
    this.running.delete(id);
    clearInterval(r.timer);
    r.server.closeAllConnections?.();
    r.server.close();
    if (!quiet) this.onChange();
    return true;
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id, { quiet: true });
  }
}
