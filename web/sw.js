// The phone app's service worker (registered only there: web/js/features/cache.js). wisp's page
// comes through an SSH tunnel, so the page and its files are served from this cache at once, and
// the page is fetched behind it. Scripts and stylesheets are named by their content (?v=,
// server/http/static.js), so two builds' files never mix: when the server has a new build (x-wisp-build),
// the page drops the cached page and whatever isn't named that way, keeps the files the new build
// still names, and reloads onto it (checkBuild in cache.js).
// The API (/api/…) is never cached here, nor a wisp Grid's own paths (/_grid/…: its sign-in link
// and waking page must reach the grid).

const CACHE = 'wisp-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_grid/') || url.pathname === '/sw.js') return;
  e.respondWith(req.mode === 'navigate' ? page() : file(req));
});

// Every path is the same page (the app routes itself): one cached copy under '/'. Once it's
// cached the network isn't asked here at all; the page checks the build itself.
async function page() {
  const cache = await caches.open(CACHE);
  const cached = await cache.match('/');
  if (cached) return cached;
  const r = await fetch('/');
  if (r.ok) cache.put('/', r.clone()).catch(() => {});
  return r;
}

async function file(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === 'basic') cache.put(req, r.clone()).catch(() => {});
  return r;
}
