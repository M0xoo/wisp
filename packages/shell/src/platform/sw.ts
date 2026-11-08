// The service worker (v1 web/sw.js; built by apps/web into dist/sw.js, for the phone's browser and the installed web app). The page and
// its content-named files come from this cache at once; the network is asked behind them.
//   - install: every module in one request (`/_pack` → {url: text}, crates/wisp-api statics/pack.rs),
//     not ~40 round trips over a slow tunnel, then the page itself (`x-wisp-sw: 1`: the normal page,
//     not the phone's boot page that waits for this worker);
//   - navigations: the cached page, then a check behind it: a page naming another build (x-wisp-build)
//     brings that build's modules (one /_pack, minus what's here), replaces the page and tells the
//     tabs, which offer Reload. Two builds' files never mix: their names carry their hashes;
//   - never cached: /api/ (the sync stream, commands), /_grid/ (the grid's sign-in and waking page),
//     /__mock/, /sw.js itself.

interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(r: Promise<Response> | Response): void;
  waitUntil(p: Promise<unknown>): void;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: { claim(): Promise<void>; matchAll(o?: { type?: string }): Promise<readonly { postMessage(m: unknown): void }[]> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate' | 'fetch', fn: (e: FetchEventLike) => void): void;
}

const sw = globalThis as unknown as WorkerScope;
const CACHE = 'wisp-v2';
const BUILD = 'x-wisp-build';
const MIME: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json' };

const skip = (url: URL): boolean =>
  url.origin !== sw.location.origin || ['/api/', '/_grid/', '/__mock/', '/@'].some((p) => url.pathname.startsWith(p)) || url.pathname === '/sw.js' || url.pathname === '/_pack';

async function put(cache: Cache, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([url, text]) => {
      const ext = url.split('?')[0]?.split('.').pop() ?? '';
      return cache.put(url, new Response(text, { headers: { 'content-type': MIME[ext] ?? 'text/plain' } }));
    }),
  );
}

/** Brings the page (and, when its build is new, its modules) into the cache. */
async function refresh(cache: Cache): Promise<'same' | 'new' | 'failed'> {
  const old = await cache.match('/');
  const page = await fetch('/', { headers: { 'x-wisp-sw': '1' }, cache: 'no-store' }).catch(() => undefined);
  if (!page?.ok) return 'failed';
  const build = page.headers.get(BUILD);
  if (old && build !== null && old.headers.get(BUILD) === build) return 'same';
  const have = (await cache.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith('/assets/'));
  const pack = await fetch(`/_pack${have.length ? `?have=${encodeURIComponent(have.join(','))}` : ''}`).catch(() => undefined);
  if (pack?.ok) await put(cache, (await pack.json()) as Record<string, string>).catch(() => {});
  await cache.put('/', page);
  return old ? 'new' : 'same';
}

async function tell(message: unknown): Promise<void> {
  for (const c of await sw.clients.matchAll({ type: 'window' })) c.postMessage(message);
}

async function navigate(): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match('/');
  const check = refresh(cache).then((r) => (r === 'new' ? tell({ t: 'update' }) : undefined));
  if (cached) {
    void check.catch(() => {});
    return cached;
  }
  await check.catch(() => {});
  return (await cache.match('/')) ?? fetch('/', { headers: { 'x-wisp-sw': '1' } });
}

async function file(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === 'basic' && new URL(req.url).pathname.startsWith('/assets/')) cache.put(req, r.clone()).catch(() => {});
  return r;
}

sw.addEventListener('install', (e) => {
  void sw.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => refresh(c)));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || skip(url)) return;
  e.respondWith(req.mode === 'navigate' ? navigate() : file(req));
});
