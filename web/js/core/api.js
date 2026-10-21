// The wisp HTTP API (server/routes/). A failed request throws with the server's message.

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    // The server only accepts JSON on non-GET requests (CSRF guard), even body-less DELETEs.
    headers: method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
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
