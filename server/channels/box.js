// A cloud wisp asking its grid about channels: which grid, and the URL its webhooks go to. The Box
// secret is fine for this, since the answer only ever reaches this same box (grid/inbox.js).

import { gridJson } from '../grid-client.js';
import { bad } from '../util.js';

// { grid, auth }, or null: not on a grid, or a sandbox, which is one task's box and has no channels.
export function boxGrid(env = process.env) {
  const grid = String(env.WISP_GRID_URL || '').replace(/\/+$/, '');
  const secret = env.WISP_TRUSTED_PROXY_SECRET;
  if (!grid || !secret || !env.WISP_PUBLIC_URL || env.WISP_SANDBOX === '1') return null;
  return { grid, auth: `Box ${new URL(env.WISP_PUBLIC_URL).hostname.split('.')[0]} ${secret}` };
}

// { url, dropped }, or null when this grid has no hub (off, or older). Rejects when it can't tell.
export async function channelUrl(box, channel) {
  const r = await gridJson(`${box.grid}/api/channels/url?channel=${encodeURIComponent(channel)}`, { headers: { authorization: box.auth }, timeout: 10_000 });
  if (r.status === 404 || r.status === 401) return null;
  if (r.status !== 200 || !r.body.url) throw new Error(r.body.error || `it said ${r.status}`);
  return r.body;
}

// A new URL: the one it had stops working here and now. { url }.
export async function rotateUrl(box, channel) {
  const r = await gridJson(`${box.grid}/api/channels/url/rotate?channel=${encodeURIComponent(channel)}`, { method: 'POST', headers: { authorization: box.auth }, timeout: 10_000 });
  if (r.status !== 200 || !r.body.url) throw bad(`The grid didn’t rotate it: ${r.body.error || `it said ${r.status}`}.`, 502);
  return r.body;
}

// What the grid says of this person's X link, or null when it has no X.
export async function xState(box) {
  const r = await gridJson(`${box.grid}/_grid/x/state`, { headers: { authorization: box.auth }, timeout: 10_000 });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(r.body.error || `it said ${r.status}`);
  return r.body;
}

// An answer in a thread this box accepted: the grid knows who to, and won't be told. { ok, held }.
export async function xReply(box, { thread, text }) {
  const r = await gridJson(`${box.grid}/_grid/x/reply`, { method: 'POST', headers: { authorization: box.auth }, body: { thread, text }, timeout: 20_000 });
  if (r.status !== 200) throw new Error(r.body.error || `the grid said ${r.status}`);
  return r.body;
}
