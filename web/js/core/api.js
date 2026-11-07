// The wisp HTTP API (server/routes/). A failed request throws with the server's message.

// index.html asks for the first lists before the modules load: the first GET of each takes it.
const boot = (typeof window !== 'undefined' && window.wispBoot) || {};
const early = (path) => {
  const r = boot[path];
  delete boot[path];
  return r?.catch(() => null);
};

// No answer at all: a person reads this, not the browser's own words ("Failed to fetch", "Load
// failed", "signal timed out"). The tests in test/api-errors.test.js hold them to it.
const CANT_REACH = 'Can’t reach wisp. Check the connection and try again.';
const TOO_SLOW = 'wisp took too long to answer. Try again.';

// A reload or a link away: WebKit fails what's still out as the page goes (Chrome just drops it),
// before pagehide, and an error then would flash a toast or roll back what was just done. Not for
// long: a vscode:// link fires beforeunload too, and that page stays.
let leaving = 0;
globalThis.addEventListener?.('beforeunload', () => {
  leaving = Date.now();
});
const goingAway = () => Date.now() - leaving < 2000;

// fetch() that fails in wisp's words. For a call that can't go through api().
export const reach = (url, opts) =>
  fetch(url, opts).catch((err) => {
    if (goingAway()) return new Promise(() => {});
    if (err?.name !== 'TypeError' && err?.name !== 'TimeoutError') throw err;
    throw new Error(err.name === 'TimeoutError' ? TOO_SLOW : CANT_REACH);
  });

// The page going away (a reload, a closed tab) cuts off what's on its way, and that looks like no
// answer before the page is gone. beforeunload comes first; the time limit is for one that didn't
// lead anywhere (a download, a link to another app).
let leavingUntil = 0;
if (typeof addEventListener === 'function') {
  for (const ev of ['beforeunload', 'pagehide']) addEventListener(ev, () => (leavingUntil = Date.now() + 3000));
}
export const pageLeaving = () => Date.now() < leavingUntil;

// A refused response as an Error: the server's message, or, from a proxy or tunnel in front of a wisp
// that's gone, the same words as no answer. statusText is empty over HTTP/2.
export const refused = (r, j) =>
  Object.assign(new Error(j.error || (r.status >= 502 && r.status <= 504 ? CANT_REACH : r.statusText || 'wisp couldn’t do that. Try again.')), { status: r.status });

// timeout (ms): give up on a request that's still out by then. On a phone a dead connection can
// look open for minutes, and a load others wait on (an open task's copy) would hold them all.
export async function api(path, { method = 'GET', body, priority, timeout } = {}) {
  const r =
    (method === 'GET' && (await early(path))) ||
    (await reach(`/api${path}`, {
      method,
      priority, // a fetch ahead goes 'low', so the one waited for isn't queued behind it
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
      // The server only accepts JSON on non-GET requests (CSRF guard), even body-less DELETEs.
      headers: method !== 'GET' ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(refused(r, j), { ...(j.hold && { hold: j.hold }), ...(j.sandboxLogin && { sandboxLogin: true }) }); // hold: Ask near the limit (server/guard.js); sandboxLogin: services/sandbox.js
  return j;
}

// A load that may be asked for again while it's still on its way: the second caller shares the
// first request. since(t): a load asked for at t or later, on its way or done, will do (boot and
// the live stream's first `hello` both load the lists).
export function shared(load) {
  let pending = null;
  let pendingAt = 0;
  let doneAt = -1;
  const get = () => {
    if (pending) return pending;
    const at = (pendingAt = performance.now());
    return (pending = load()
      .then((v) => ((doneAt = at), v))
      .finally(() => (pending = null)));
  };
  get.since = (t) => (pending && pendingAt >= t ? pending : doneAt >= t ? Promise.resolve() : get());
  return get;
}

// An attachment: the raw bytes, with its name and type in the query. Resolves to { id }.
export async function upload(file, { name, type }) {
  const r = await reach(`/api/uploads?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw refused(r, j);
  return j;
}

// Counts a click in the anonymous usage stats (server/telemetry.js PAGE_EVENTS). Never waits,
// never fails: with stats off, the server drops it.
export function track(event, props = {}) {
  api('/telemetry/event', { method: 'POST', body: { event, props } }).catch(() => {});
}
