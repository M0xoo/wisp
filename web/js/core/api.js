// The wisp HTTP API (server/routes/). A failed request throws with the server's message.

// index.html asks for the first lists before the modules load: the first GET of each takes it.
const boot = (typeof window !== 'undefined' && window.wispBoot) || {};
const early = (path) => {
  const r = boot[path];
  delete boot[path];
  return r?.catch(() => null);
};

export async function api(path, { method = 'GET', body, priority } = {}) {
  const r =
    (method === 'GET' && (await early(path))) ||
    (await fetch(`/api${path}`, {
      method,
      priority, // a fetch ahead goes 'low', so the one waited for isn't queued behind it
      // The server only accepts JSON on non-GET requests (CSRF guard), even body-less DELETEs.
      headers: method !== 'GET' ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, ...(j.hold && { hold: j.hold }) }); // hold: Ask near the limit (server/guard.js)
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
  const r = await fetch(`/api/uploads?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

// Counts a click in the anonymous usage stats (server/telemetry.js PAGE_EVENTS). Never waits,
// never fails: with stats off, the server drops it.
export function track(event, props = {}) {
  api('/telemetry/event', { method: 'POST', body: { event, props } }).catch(() => {});
}
