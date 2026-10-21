// The phone app's caches. wisp's page reaches its computer through an SSH tunnel, so the app
// shouldn't wait on it to show anything:
// - the page and its files come from a service worker's cache (web/sw.js), checked behind it;
// - the last tasks, config and open tasks seen are kept per computer (they share one origin,
//   127.0.0.1:<port>) and painted at once on the next open, then replaced by the server's.

import { COMPUTER, MOBILE, S } from '../core/state.js';
import { toast } from '../ui/toast.js';

const KEY = `wisp.snapshot.${COMPUTER || 'here'}`;
const SHELL = 'wisp-shell'; // web/sw.js
const MAX_FULL = 300_000; // an open task bigger than this (as JSON) loads from the server instead
let touched = false; // a tap or a key since the page opened: then it never reloads by itself
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => (touched = true), { once: true, capture: true });

export function recall() {
  if (!MOBILE) return null;
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

// What the next open paints first. Written when the app goes to the background or leaves the page,
// not on every live event.
export function remember() {
  if (!MOBILE || !S.sessions.size) return;
  const full = [...S.open].map((id) => [id, S.full.get(id)]).filter(([, s]) => s && JSON.stringify(s).length < MAX_FULL);
  const snap = { at: Date.now(), config: S.config, machines: S.machines, sessions: [...S.sessions.values()], full };
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // Over the storage quota: the list alone still makes the first paint.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...snap, full: [] }));
    } catch {}
  }
}

if (MOBILE) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) remember();
  });
  addEventListener('pagehide', remember);
}

// A thin bar under the top bar while what's shown may be stale: painted from the snapshot, or the
// live stream dropped (the tunnel is reconnecting).
export function syncing(on) {
  if (MOBILE) document.body.classList.toggle('syncing', on);
}

// The service worker serves the cached page; the page checks the server's build when it opens and
// whenever the live stream (re)connects, since the tunnel may come up after the page.
export function startShell() {
  if (!MOBILE || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  checkBuild();
}

// A different build (wisp was updated there, or this is a computer on another version): reload
// onto it, silently if you haven't touched the page yet, else with a toast.
let told = false;
export async function checkBuild() {
  if (!MOBILE || !('serviceWorker' in navigator)) return;
  const mine = document.querySelector('meta[name="wisp-build"]')?.content;
  const r = await fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  const build = r?.headers.get('x-wisp-build');
  if (!mine || !build) return;
  if (build === mine) return fillShell();
  const reload = async () => {
    remember();
    await caches.delete(SHELL).catch(() => {});
    location.reload();
  };
  if (!touched) return reload();
  if (told) return;
  told = true;
  toast('wisp was updated on this computer', { action: { label: 'Reload', run: reload }, timeout: 15_000 });
}

// The first open loads before the service worker is in charge, so it caches nothing: put what this
// page loaded in its cache now (the browser's own cache answers most of it), so the next open
// needs no network at all.
async function fillShell() {
  const cache = await caches.open(SHELL).catch(() => null);
  if (!cache) return;
  const files = performance
    .getEntriesByType('resource')
    .map((r) => new URL(r.name))
    .filter((u) => u.origin === location.origin && !u.pathname.startsWith('/api/'))
    .map((u) => u.pathname + u.search);
  await Promise.all(['/', ...new Set(files)].map(async (url) => (await cache.match(url)) || cache.add(url).catch(() => {})));
}
