// The phone app's service worker (registered only there: web/js/features/cache.js). wisp's page
// comes through an SSH tunnel, so the page and its files are served from this cache at once, and
// the page is fetched behind it. The cache only ever holds one build (x-wisp-build,
// server/http/static.js), so files from two versions never mix: when the server has a new one, the
// page drops the cache and reloads onto it (startShell in cache.js).
// The API (/api/…) is never cached here.

const CACHE = 'wisp-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
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
