// Reveal on a masked .env view (server/env-mask.js). The server sends a .env file's values as
// KEY=•••• with masked: the query that fetches that one step, change or block as it is. Revealed
// ones stay revealed in this tab until Hide, so a refresh of the task doesn't hide them again.

import { api } from './core/api.js';
import { esc } from './md.js';

const shown = new Map(); // `${sessionId}?${masked}` -> the unmasked value

const key = (sid, q) => `${sid}?${q}`;
export const revealedOf = (sid, q) => (sid && q ? shown.get(key(sid, q)) : undefined);

// Fetch it unmasked; throws on a refusal (the caller toasts).
export async function reveal(sid, q) {
  const { value } = await api(`/sessions/${sid}/unmasked?${q}`);
  shown.set(key(sid, q), value);
  return value;
}
export const hide = (sid, q) => shown.delete(key(sid, q));

// The line over a masked view: what's hidden and the button that shows it (or hides it again).
// data-env carries the query; the caller wires the click.
export function maskBar(file, q, open, attrs = '') {
  const name = String(file || '.env').split(/[\\/]/).pop();
  return `<div class="env-mask"><span class="env-what">${open ? `Showing ${esc(name)}’s values` : `${esc(name)}’s values are hidden`}</span><button type="button" class="ghost xs env-reveal" data-env="${esc(q)}" aria-pressed="${!!open}"${attrs}>${open ? 'Hide' : 'Reveal'}</button></div>`;
}
