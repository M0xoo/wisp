// POST { event, session, markdown } to each configured webhook (Slack bridges, CI, notifiers).
// event: session.waiting (blocked on ask_user) | session.finished. Fire and forget.

import { sessionToMarkdown } from '../render.js';
import { VERSION } from '../util.js';

export function notifyWebhooks(store, summary) {
  const hooks = store.config.webhooks || [];
  if (!hooks.length) return;
  const s = store.get(summary.id);
  if (!s) return;
  const event = s.state === 'waiting' ? 'session.waiting' : 'session.finished';
  const body = JSON.stringify({ event, session: summary, markdown: sessionToMarkdown(s), at: Date.now() });
  for (const h of hooks) {
    if (h.events?.length && !h.events.includes(event)) continue;
    fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `wisp/${VERSION}` }, body, signal: AbortSignal.timeout(10_000) }).catch((err) =>
      console.warn(`wisp: webhook ${h.url} failed: ${err.message}`),
    );
  }
}

// A webhook entry from the config API: a URL string or { url, events }.
export function normalizeWebhooks(list) {
  const hooks = Array.isArray(list) ? list : [];
  const wrong = hooks.find((h) => !/^https?:\/\/\S+$/.test(String(h?.url ?? h)));
  if (wrong !== undefined) return { error: `Not an http(s) URL: ${wrong?.url ?? wrong}` };
  return { hooks: hooks.map((h) => (typeof h === 'string' ? { url: h } : { url: h.url, events: Array.isArray(h.events) ? h.events : undefined })) };
}
