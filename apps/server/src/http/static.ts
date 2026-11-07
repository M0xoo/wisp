// The web UI (v1 server/http/static.js): apps/web's built files, with index.html for every other path
// (the app routes itself). The phone loads it through an SSH tunnel where each round trip is slow, so:
//   - every file is read once into memory, hashed, and compressed once (gzip 9 and brotli 11, one file
//     at a time on the thread pool so the first requests aren't held), revalidated by ETag;
//   - the bundler names files by content (assets/x-<hash>.js): those are cached for good, a reload asks
//     for none of them, and a new build gets new URLs. Anything else is no-cache (a 304 when unchanged);
//   - index.html names the build (meta wisp-build and x-wisp-build) so the phone's service worker can
//     tell its copy is old, and the phone's first open (wispMobile without x-wisp-sw) gets a page whose
//     modules wait for the worker, which fetches every module in one request: /_pack.
// Nothing here blocks: files are read with fs/promises, and a big pack is brotli'd in slices so a wisp
// stopped right after it started doesn't wait seconds on one thread-pool job (v1 static-exit test).
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  // iOS reads the home-screen manifest by this URL when it's added: unversioned, no-cache
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.map', '.md', '.webmanifest', '.txt']);
const MAX_CACHED = 4e6; // bigger files (videos) are streamed, not held
/** a bundler's content hash in a file name: `index-B3x9_aQz.js` */
export const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

interface Entry {
  body: Buffer;
  etag: string;
  mtimeMs: number;
  size: number;
  text: boolean;
  gz: Buffer | null;
  br: Buffer | null;
}

interface Page {
  build: string;
  normal: Entry;
  boot: Entry;
}

const hash = (buf: Buffer | string): string => crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20);

const BOOT = `(function () {
    var urls = PRELOADS, sw = navigator.serviceWorker, went = false;
    var go = function () {
      if (went) return;
      went = true;
      urls.forEach(function (u, i) {
        var e = document.createElement(i === urls.length - 1 ? 'script' : 'link');
        if (i === urls.length - 1) { e.type = 'module'; e.src = u; } else { e.rel = 'modulepreload'; e.href = u; }
        document.head.append(e);
      });
    };
    if (!sw || sw.controller) return go();
    sw.addEventListener('controllerchange', go);
    sw.register('/sw.js').then(function (r) {
      var w = r.installing || r.waiting;
      if (w) w.addEventListener('statechange', function () { if (w.state === 'redundant') go(); });
      else if (!sw.controller) go();
    }, go);
    setTimeout(go, 180000);
  })();`;

const SLICE = 64 * 1024;
/** brotli fed in slices: many short pool jobs instead of one that holds process.exit for seconds */
function brotliInPieces(body: Buffer, params: Record<number, number>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = zlib.createBrotliCompress({ params });
    const out: Buffer[] = [];
    z.on('data', (d: Buffer) => out.push(d));
    z.on('end', () => resolve(Buffer.concat(out)));
    z.on('error', reject);
    let at = 0;
    const next = (): void => {
      if (at >= body.length) {
        z.end();
        return;
      }
      const slice = body.subarray(at, (at += SLICE));
      if (z.write(slice)) setImmediate(next);
      else z.once('drain', next);
    };
    next();
  });
}

export interface StaticOptions {
  /** the built web app (apps/web/dist, or dist/web beside the bundle) */
  dir: string;
}

export class StaticFiles {
  readonly dir: string;
  readonly #files = new Map<string, Entry>();
  #page: Page | null = null;
  /** when the build was last checked: re-stat every file at most every 2 s, not on every page load */
  #pageAt = 0;
  #pack: (Entry & { build: string }) | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: StaticOptions) {
    this.dir = path.resolve(opts.dir);
  }

  get #index(): string {
    return path.join(this.dir, 'index.html');
  }

  /** Compress on the pool, one file at a time; the plain body serves until it's ready. */
  #compress(e: Entry): void {
    this.#queue = this.#queue
      .then(() => new Promise<void>((done) => zlib.gzip(e.body, { level: 9 }, (err, gz) => ((e.gz = err ? null : gz), done()))))
      .then(() => brotliInPieces(e.body, { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.body.length }))
      .then((br) => (e.br = br), () => undefined);
  }

  async #read(file: string): Promise<Entry | null> {
    let st;
    try {
      st = await stat(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const had = this.#files.get(file);
    if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had; // keyed on stat: a rebuild shows at once
    if (st.size > MAX_CACHED) return { body: Buffer.alloc(0), etag: '', mtimeMs: st.mtimeMs, size: st.size, text: false, gz: null, br: null };
    const body = await readFile(file);
    const e: Entry = { body, etag: `"${hash(body)}"`, mtimeMs: st.mtimeMs, size: st.size, text: TEXT.has(path.extname(file)) && body.length > 1024, gz: null, br: null };
    if (e.text) this.#compress(e);
    this.#files.set(file, e);
    return e;
  }

  async #all(dir = this.dir): Promise<string[]> {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const d of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) out.push(...(await this.#all(p)));
      else if (d.isFile()) out.push(p);
    }
    return out;
  }

  #url(file: string): string {
    return `/${path.relative(this.dir, file).split(path.sep).join('/')}`;
  }

  /** index.html with the build named, and its boot twin for the phone's first open. */
  async #indexPage(): Promise<Page | null> {
    if (this.#page && Date.now() - this.#pageAt < 2000) return this.#page;
    this.#pageAt = Date.now();
    const files = await this.#all();
    const entries = await Promise.all(files.map((f) => this.#read(f)));
    const build = hash(entries.map((e) => e?.etag ?? '').join());
    if (this.#page?.build === build) return this.#page;
    const src = (await this.#read(this.#index))?.body.toString();
    if (src === undefined) return null;
    const meta = `  <meta name="wisp-build" content="${build}">`;
    const html = src.replace('</head>', `${meta}\n</head>`);
    // the boot page: the module scripts and preloads wait for the service worker (BOOT puts them back)
    const scripts = [...html.matchAll(/<script type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g)];
    const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*\shref="([^"]+)"[^>]*>/g)];
    const urls = [...preloads.map((m) => m[1] ?? ''), ...scripts.map((m) => m[1] ?? '')].filter(Boolean);
    let boot = html;
    for (const m of [...scripts, ...preloads]) boot = boot.replace(m[0], '');
    boot = boot.replace('</head>', `  <script>${BOOT.replace('PRELOADS', JSON.stringify(urls))}</script>\n</head>`);
    const make = (text: string, etag: string): Entry => {
      const body = Buffer.from(text);
      const e: Entry = { body, etag, mtimeMs: 0, size: body.length, text: true, gz: null, br: null };
      this.#compress(e);
      return e;
    };
    this.#page = { build, normal: make(html, `"${build}"`), boot: make(boot, `"${build}-boot"`) };
    return this.#page;
  }

  /** The built page and every file it names, read, hashed and compressed before the window asks. */
  async warm(): Promise<void> {
    try {
      await this.#indexPage();
      await this.#packFor(new Set());
    } catch {
      // no web build (a dev checkout before `npm run build`): the API still serves
    }
  }

  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/_pack') return this.#servePack(req, res);
    let rel = pathname;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      // a malformed escape is no file: the SPA fallback answers
    }
    const p = path.normalize(path.join(this.dir, rel === '/' ? 'index.html' : rel));
    // inside the web dir only: a sibling folder whose name starts the same doesn't count
    const inside = p.startsWith(this.dir + path.sep) && p !== this.#index;
    const file = inside ? await this.#read(p) : null;
    if (file && file.size > MAX_CACHED) {
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': file.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(p).pipe(res);
      return;
    }
    if (file) return this.#answer(req, res, file, path.extname(p), HASHED.test(p) && p.includes(`${path.sep}assets${path.sep}`), null);
    // a path with an extension that isn't here is a 404, not the app (a stale chunk must fail loudly)
    if (/\.[a-z0-9]+$/i.test(rel) && !rel.endsWith('.html')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      res.end('not found');
      return;
    }
    const page = await this.#indexPage();
    if (!page) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('The web app is not built: run npm run build');
      return;
    }
    const boot = /\bwispMobile\b/.test(String(req.headers['user-agent'] ?? '')) && !req.headers['x-wisp-sw'];
    return this.#answer(req, res, boot ? page.boot : page.normal, '.html', false, page.build);
  }

  #answer(req: IncomingMessage, res: ServerResponse, f: Entry, ext: string, forGood: boolean, build: string | null): void {
    const headers: Record<string, string | number> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': forGood ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: f.etag,
    };
    if (build) headers['x-wisp-build'] = build;
    if (f.text) headers['vary'] = build ? 'accept-encoding, x-wisp-sw' : 'accept-encoding';
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const ae = String(req.headers['accept-encoding'] ?? '');
    const enc = f.br && /\bbr\b/.test(ae) ? 'br' : f.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
    if (enc) headers['content-encoding'] = enc;
    const body = enc === 'br' ? (f.br ?? f.body) : enc === 'gzip' ? (f.gz ?? f.body) : f.body;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** Every module, as one JSON answer {url: text}, minus those the worker has (?have=<hash or url>,…). */
  async #packFor(have: ReadonlySet<string>): Promise<Entry & { build: string }> {
    const page = await this.#indexPage();
    const build = page?.build ?? '';
    const all = have.size === 0;
    if (all && this.#pack?.build === build) return this.#pack;
    const out: Record<string, string> = {};
    for (const f of await this.#all()) {
      if (!/\.m?js$/.test(f)) continue;
      const url = this.#url(f);
      const e = await this.#read(f);
      if (!e || have.has(url) || have.has(e.etag.slice(1, -1))) continue;
      out[url] = e.body.toString();
    }
    const body = Buffer.from(JSON.stringify(out));
    const entry = { build, body, etag: `"${hash(body)}"`, mtimeMs: 0, size: body.length, text: true, gz: null, br: null } as Entry & { build: string };
    if (!all) return entry;
    this.#pack = entry;
    brotliInPieces(body, { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length }).then(
      (br) => (entry.br = br),
      () => undefined,
    );
    zlib.gzip(body, { level: 9 }, (err, gz) => (entry.gz = err ? null : gz));
    return entry;
  }

  async #servePack(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = /[?&]have=([^&]*)/.exec(req.url ?? '')?.[1] ?? '';
    const have = new Set(raw.split(',').filter(Boolean).map((s) => decodeURIComponent(s)));
    const p = await this.#packFor(have);
    const headers: Record<string, string | number> = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-wisp-build': p.build, vary: 'accept-encoding' };
    const ae = String(req.headers['accept-encoding'] ?? '');
    const send = (enc: 'br' | 'gzip' | null, body: Buffer): void => {
      if (enc) headers['content-encoding'] = enc;
      headers['content-length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (p.br && /\bbr\b/.test(ae)) return send('br', p.br);
    if (p.gz && /\bgzip\b/.test(ae)) return send('gzip', p.gz);
    // not compressed yet (asked right after a start, or a partial pack): quickly, off the event loop
    if (/\bbr\b/.test(ae)) {
      zlib.brotliCompress(p.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: p.body.length } }, (err, br) => (err ? send(null, p.body) : send('br', br)));
      return;
    }
    if (/\bgzip\b/.test(ae)) {
      zlib.gzip(p.body, { level: 6 }, (err, gz) => (err ? send(null, p.body) : send('gzip', gz)));
      return;
    }
    send(null, p.body);
  }
}
