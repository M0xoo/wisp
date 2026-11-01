// The phone app's service worker (registered only there: web/js/features/cache.js). wisp's page
// comes through an SSH tunnel, so the page and its files are served from this cache at once, and
// the page is fetched behind it. Scripts and stylesheets are named by their content (?v=,
// server/http/static.js), so two builds' files never mix: when the server has a new build (x-wisp-build),
// the page drops the cached page and whatever isn't named that way, keeps the files the new build
// still names, and reloads onto it (checkBuild in cache.js).
// The API (/api/…) is never cached here, nor a wisp Grid's own paths (/_grid/…: its sign-in link
// and waking page must reach the grid).
// Files come in one request, not one each: over the tunnel's six connections ~120 files are ~20
// round trips. Whenever the page comes from the network (installing, after an update), the files it
// names that aren't here yet come together from /_pack (server/http/static.js). The first open
// waits for the install before it loads its modules (index.html's boot script).

const CACHE = 'wisp-shell';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(page());
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_grid/') || url.pathname === '/sw.js') return;
  e.respondWith(req.mode === 'navigate' ? page() : file(req));
});

// Every path is the same page (the app routes itself): one cached copy under '/'. Once it's
// cached the network isn't asked here at all; the page checks the build itself.
// x-wisp-sw: the page for a worker in charge (not the first open's boot page).
async function page() {
  const cache = await caches.open(CACHE);
  const cached = await cache.match('/');
  if (cached) return cached;
  // Nothing here yet (the first open): every file, asked for beside the page, not after it.
  const first = !(await cache.keys()).length && fetch('/_pack').then((p) => (p.ok ? p.json() : null)).catch(() => null);
  const r = await fetch('/', { headers: { 'x-wisp-sw': '1' } });
  if (r.ok && r.headers.get('x-wisp-build')) {
    await (first ? first.then((files) => files && put(cache, files)) : unpack(cache, await r.clone().text())).catch(() => {});
    await cache.put('/', r.clone()).catch(() => {});
  }
  return r;
}

const MIME = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
async function unpack(cache, html) {
  const map = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)?.[1] || '{}').imports || {};
  const named = new Set([...Object.values(map), ...[...html.matchAll(/(?:href|src)="(\/[^"]+\?v=[\w-]+)"/g)].map((m) => m[1])]);
  const here = new Set((await cache.keys()).map((r) => new URL(r.url)).map((u) => u.pathname + u.search));
  // The stylesheet: the page links it itself (and /_pack has only modules).
  const css = (u) => u.split('?')[0].endsWith('.css');
  const missing = [...named].filter((u) => !here.has(u) && !css(u));
  if (missing.length < 2) return; // one file is one request either way
  const have = [...named].filter((u) => here.has(u) || css(u)).map((u) => u.split('v=')[1]);
  const r = await fetch(`/_pack?have=${have.join(',')}`);
  if (!r.ok) return;
  await put(cache, await r.json());
}
function put(cache, files) {
  return Promise.all(
    Object.entries(files).map(([url, text]) => cache.put(url, new Response(text, { headers: { 'content-type': MIME[url.split('?')[0].split('.').pop()] || 'text/plain' } }))),
  );
}

async function file(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === 'basic') cache.put(req, r.clone()).catch(() => {});
  return r;
}
