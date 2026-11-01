// The web UI: files under web/, with index.html for every other path (the app routes itself).
//
// The phone app loads this page through an SSH tunnel, where every round trip and every byte is
// slow, so files are kept in memory (re-read when they change on disk), gzipped once, and
// revalidated by ETag (a 304 instead of the file). index.html names every script and stylesheet by
// its content (`?v=<hash>`, modules through an import map, since they import each other by plain
// paths), and those URLs are cached for good: a reload asks for none of them again, which matters
// most across the internet (wisp Grid), and a changed file gets a new URL. index.html also preloads every module app.js
// imports, so the browser fetches them in parallel instead of one import level at a time, and
// names the build (x-wisp-build) so the phone's service worker (web/sw.js) can tell when its cached
// copy is out of date.
//
// Round trips cost more than bytes there: the tunnel is HTTP/1.1, six requests at a time, so ~150
// files took ~28 round trips (56 s on a 3G link, 2 s each). The stylesheets go as one file
// (/css/all.css, in index.html's order), and the phone's first open gets every module in one
// request (/_pack, unpacked into the service worker's cache: index.html waits for it), which also
// compresses better than the files one by one (376 KB of brotli instead of 492 KB).

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
  '.m4v': 'video/mp4',
  '.pdf': 'application/pdf',
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.md']);
const MAX_CACHED = 4e6; // bigger files (videos) are streamed, not held in memory

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20);

// Text is compressed on the thread pool, gzip first and then brotli at its best (about 13% smaller
// than gzip over all of web/, two seconds of CPU once per start), one file at a time so the pool
// stays free for the rest of the server and a start doesn't hold the first requests: each is
// served as soon as it's ready, plain until then.
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } };
let gzips = Promise.resolve();
let brotlis = Promise.resolve();
const compress = (entry, body) => {
  gzips = gzips.then(() => new Promise((done) => zlib.gzip(body, { level: 9 }, (err, gz) => done(!err && (entry.gz = gz)))));
  brotlis = brotlis.then(() => new Promise((done) => zlib.brotliCompress(body, BROTLI, (err, br) => done(!err && (entry.br = br)))));
  return entry;
};

// The page's modules go without their comment lines (a fifth of their bytes, compressed): each
// whole-line `//` comment becomes an empty line, so line numbers still match the source. Strings,
// template literals and regexes are skipped over; anything it can't follow goes as it is.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
export function blankComments(src) {
  const lines = [];
  const stack = [0]; // a number: code, its open braces; 'tpl': inside a template literal
  let prev = ''; // the last token in code: a regex can follow an operator, not a value
  let i = 0;
  let lineStart = true;
  const n = src.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top === 'tpl') {
      if (c === '\\') i += 2;
      else if (c === '`') (stack.pop(), (prev = 'v'), i++);
      else if (c === '$' && src[i + 1] === '{') (stack.push(0), (prev = '('), (i += 2));
      else i++;
      continue;
    }
    if (c === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      if (lineStart) lines.push([i, end === -1 ? n : end]);
      i = end === -1 ? n : end;
      continue;
    }
    lineStart = false;
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return src;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\n') return src;
        j += src[j] === '\\' ? 2 : 1;
      }
      if (j >= n) return src;
      i = j + 1;
      prev = 'v';
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      i++;
      continue;
    }
    if (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || REGEX_AFTER.has(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < n && (cls || src[j] !== '/')) {
        if (src[j] === '\n') return src;
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      if (j >= n) return src;
      i = j + 1;
      while (i < n && /\w/.test(src[i])) i++;
      prev = 'v';
      continue;
    }
    if (c === '{') stack[stack.length - 1]++;
    if (c === '}') {
      if (top === 0) {
        if (stack.length === 1) return src;
        stack.pop(); // the end of a template's ${…}
        i++;
        continue;
      }
      stack[stack.length - 1]--;
    }
    const word = /^[\w$]+/.exec(src.slice(i, i + 40))?.[0];
    if (word) {
      prev = word;
      i += word.length;
      continue;
    }
    prev = c;
    i++;
  }
  if (stack.length !== 1 || stack[0] !== 0) return src;
  let out = '';
  let at = 0;
  for (const [a, b] of lines) {
    const from = src.lastIndexOf('\n', a) + 1; // the line's indentation goes too
    out += src.slice(at, from);
    at = b;
  }
  return out + src.slice(at);
}
const JS_DIR = path.join(WEB, 'js') + path.sep;

// path -> { mtimeMs, size, body, gz, br, etag }. Keyed on the file's stat, so an edit shows at once.
const files = new Map();
function read(p) {
  const st = fs.statSync(p);
  const f = files.get(p);
  if (f && f.mtimeMs === st.mtimeMs && f.size === st.size) return f;
  const ext = path.extname(p);
  const raw = fs.readFileSync(p);
  const body = ext === '.js' && p.startsWith(JS_DIR) ? Buffer.from(blankComments(raw.toString())) : raw;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag: `"${hash(body)}"`, gz: null, br: null, text: TEXT.has(ext) && body.length > 1024 };
  if (entry.text) compress(entry, body);
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

// A file's URL with its content in it: what index.html links to.
const version = (p) => read(p).etag.slice(1, 13);
const urlOf = (p) => '/' + path.relative(WEB, p).split(path.sep).join('/');
const versioned = (u) => `${u}?v=${version(path.join(WEB, u))}`;

// The stylesheets index.html links, in its order, as one file: /css/all.css?v=<its content>.
const SHEETS = /(?:[ \t]*<link rel="stylesheet" href="\/css\/[^"?]+\.css">\n)+/;
const CSS_ALL = '/css/all.css';
let sheets = null;
function allCss(html) {
  const urls = [...(SHEETS.exec(html)?.[0] || '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => isFile(path.join(WEB, u)));
  const key = urls.map((u) => read(path.join(WEB, u)).etag).join();
  if (sheets?.key === key) return sheets;
  const body = Buffer.from(urls.map((u) => `/* ${u} */\n${read(path.join(WEB, u)).body}`).join('\n'));
  const etag = `"${hash(body)}"`;
  sheets = compress({ key, body, etag, v: etag.slice(1, 13), text: true }, body);
  return sheets;
}

// index.html with the preloads, and the build: a hash of every file under web/, so two computers
// on the same wisp version agree on it (the phone reaches both through one origin).
// page.boot is what the phone app's first open gets (no service worker in charge yet): the same
// page, but its modules wait until the worker has unpacked them all (/_pack) and is in charge, then
// load from its cache. Without one (no support, it failed), they load as usual.
let page = null;
function index() {
  const all = webFiles();
  const build = hash(all.map((p) => read(p).etag).join());
  if (page?.build === build) return page;
  const modules = all.filter((p) => p.startsWith(path.join(WEB, 'js') + path.sep) && p.endsWith('.js')).map(urlOf);
  const map = `  <script type="importmap">${JSON.stringify({ imports: Object.fromEntries(modules.map((u) => [u, versioned(u)])) })}</script>`;
  const preloads = moduleGraph().map(versioned);
  const links = preloads.map((u) => `  <link rel="modulepreload" href="${u}">`);
  const meta = `  <meta name="wisp-build" content="${build}">`;
  const src = read(INDEX).body.toString();
  const css = allCss(src);
  const html = src
    .replace(SHEETS, `  <link rel="stylesheet" href="${CSS_ALL}?v=${css.v}">\n`)
    .replace(/(href|src)="(\/(?:css|js)\/[^"?]+)"/g, (m, attr, u) => (isFile(path.join(WEB, u)) ? `${attr}="${versioned(u)}"` : m));
  const app = versioned('/js/app.js');
  const tag = `<script type="module" src="${app}"></script>`;
  const body = Buffer.from(html.replace('</head>', `${[map, meta, ...links].join('\n')}\n</head>`));
  const boot = Buffer.from(html.replace(tag, '').replace('</head>', `${[map, meta, `  <script>${BOOT.replace('PRELOADS', JSON.stringify([...preloads, app]))}</script>`].join('\n')}\n</head>`));
  page = compress({ build, body, etag: `"${build}"`, text: true }, body);
  page.boot = compress({ build, body: boot, etag: `"${build}-boot"`, text: true }, boot);
  return page;
}

// The phone app's first open: put the service worker in charge (its install unpacks /_pack), then
// load the modules from its cache. The last URL is app.js; the rest are preloads.
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
  if (pathname === '/_pack') return servePack(req, res);
  const p = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
  // Inside web/ only: a sibling folder whose name starts with "web" doesn't count. Anything else
  // is the SPA fallback.
  const file = p.startsWith(WEB + path.sep) && p !== INDEX && isFile(p) ? p : null;
  const ext = file ? path.extname(file) : '.html';
  if (file && fs.statSync(file).size > MAX_CACHED) {
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  // The phone app's first open, before its service worker is in charge (it asks with x-wisp-sw).
  const boot = !file && /\bwispMobile\b/.test(req.headers['user-agent'] || '') && !req.headers['x-wisp-sw'];
  const css = !file && pathname === CSS_ALL ? allCss(read(INDEX).body.toString()) : null;
  const f = css || (file ? read(file) : boot ? index().boot : index());
  // A URL naming this content (index.html's ?v=) never changes meaning: kept for good. Anything
  // else, no-cache: the browser keeps the file but asks first, and an unchanged one costs a 304.
  const v = /[?&]v=([\w-]+)/.exec(req.url || '')?.[1];
  const forGood = v && (css ? v === css.v : file && v === version(file));
  const headers = { 'content-type': MIME[css ? '.css' : ext] || 'application/octet-stream', 'cache-control': forGood ? 'public, max-age=31536000, immutable' : 'no-cache', etag: f.etag };
  if (!file && !css) headers['x-wisp-build'] = f.build;
  if (f.text) headers.vary = !file && !css ? 'accept-encoding, x-wisp-sw' : 'accept-encoding';
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ae = req.headers['accept-encoding'] || '';
  const enc = f.br && /\bbr\b/.test(ae) ? 'br' : f.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
  if (enc) headers['content-encoding'] = enc;
  const body = enc === 'br' ? f.br : enc === 'gzip' ? f.gz : f.body;
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Every module index.html names, as one JSON answer { "<url>?v=…": "<text>" }, for the phone's
// service worker to unpack into its cache: all of them on its first open, and after an update the
// ones it doesn't have (?have=<the versions it has>, comma-separated). The whole pack is
// brotli'd at its best once per build (in warmStatic); a partial one, quickly, when asked.
let packed = null;
function pack(have) {
  const { build } = index();
  const all = !have.size;
  if (all && packed?.build === build) return packed;
  const out = {};
  for (const p of webFiles(path.join(WEB, 'js'))) {
    if (!p.endsWith('.js') || have.has(version(p))) continue;
    out[versioned(urlOf(p))] = read(p).body.toString();
  }
  const body = Buffer.from(JSON.stringify(out));
  const entry = { build, body, etag: `"${hash(body)}"`, gz: null, br: null, text: true };
  if (!all) return entry;
  packed = entry;
  zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, (err, br) => !err && (entry.br = br));
  zlib.gzip(body, { level: 9 }, (err, gz) => !err && (entry.gz = gz));
  return entry;
}

function servePack(req, res) {
  const have = new Set((/[?&]have=([^&]*)/.exec(req.url || '')?.[1] || '').split(',').filter(Boolean).map(decodeURIComponent));
  const p = pack(have);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-wisp-build': p.build, vary: 'accept-encoding' };
  const ae = req.headers['accept-encoding'] || '';
  const send = (enc, body) => {
    if (enc) headers['content-encoding'] = enc;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (p.br && /\bbr\b/.test(ae)) return send('br', p.br);
  if (p.gz && /\bgzip\b/.test(ae)) return send('gzip', p.gz);
  // Not compressed yet (asked right after a start, or a partial pack): quickly, off the event loop.
  if (/\bbr\b/.test(ae)) return zlib.brotliCompress(p.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: p.body.length } }, (err, br) => (err ? send(null, p.body) : send('br', br)));
  if (/\bgzip\b/.test(ae)) return zlib.gzip(p.body, { level: 6 }, (err, gz) => (err ? send(null, p.body) : send('gzip', gz)));
  send(null, p.body);
}

// Right after the server is up: the page and every file it names read, hashed and compressed, so
// the first open doesn't wait on that (about 60 ms).
export function warmStatic() {
  try {
    index();
    pack(new Set());
  } catch {}
}
