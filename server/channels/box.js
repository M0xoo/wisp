// A cloud wisp asking its grid about channels: which grid, and the URL its webhooks go to. The Box
// secret is fine for this, since the answer only ever reaches this same box (grid/inbox.js).

import { createHash } from 'node:crypto';
import { gridJson } from '../grid-client.js';
import { bad } from '../util.js';

// { grid, auth }, or null: not on a grid, or a sandbox, which is one task's box and has no channels.
export function boxGrid(env = process.env) {
  const grid = String(env.WISP_GRID_URL || '').replace(/\/+$/, '');
  const secret = env.WISP_TRUSTED_PROXY_SECRET;
  if (!grid || !secret || !env.WISP_PUBLIC_URL || env.WISP_SANDBOX === '1') return null;
  return { grid, auth: `Box ${new URL(env.WISP_PUBLIC_URL).hostname.split('.')[0]} ${secret}` };
}

// Which bot this box has, to the grid (grid/route.js): proof of the token, not the token. A public id
// would let a box claim a bot it doesn't hold, and with it that bot's messages.
export const botMark = (token) => createHash('sha256').update(`wisp bot|${token}`).digest('base64url');

// { url, dropped, held? } ({ address, dropped } for email), or null when this grid has no hub (off, or
// older), or no mail. Rejects when it can't tell. bot: a botMark, and held says the grid owns that bot's webhook. gone: this box let go of it.
export async function channelUrl(box, channel, bot = '', { gone = false } = {}) {
  const r = await gridJson(`${box.grid}/api/channels/url?channel=${encodeURIComponent(channel)}${bot ? `&bot=${encodeURIComponent(bot)}` : ''}${gone ? '&gone=1' : ''}`, { headers: { authorization: box.auth }, timeout: 10_000 });
  if (r.status === 404 || r.status === 401) return null;
  if (r.status !== 200 || !(r.body.url || r.body.address)) throw new Error(r.body.error || `it said ${r.status}`);
  return r.body;
}

// A new URL: the one it had stops working here and now. { url }, or { address }.
export async function rotateUrl(box, channel) {
  const r = await gridJson(`${box.grid}/api/channels/url/rotate?channel=${encodeURIComponent(channel)}`, { method: 'POST', headers: { authorization: box.auth }, timeout: 10_000 });
  if (r.status !== 200 || !(r.body.url || r.body.address)) throw bad(`The grid didn’t rotate it: ${r.body.error || `it said ${r.status}`}.`, 502);
  return r.body;
}

// A reply to a message this box accepted: the grid knows who to, and won't be told. { messageId }.
export async function mailReply(box, { replyTo, subject, text }) {
  const r = await gridJson(`${box.grid}/api/channels/mail/reply`, { method: 'POST', headers: { authorization: box.auth }, body: { replyTo, subject, text }, timeout: 20_000 });
  if (r.status !== 200) throw new Error(r.body.error || `the grid said ${r.status}`);
  return r.body;
}

// The public key the grid's edge checks a channel's requests with, or '' to take it away. → false
// when this grid has no hub. It's public, and only this box's own URL opens with it.
export async function setChannelKey(box, channel, key) {
  const r = await gridJson(`${box.grid}/api/channels/url/key?channel=${encodeURIComponent(channel)}`, { method: 'POST', headers: { authorization: box.auth }, body: { key }, timeout: 10_000 });
  if (r.status === 404 || r.status === 401) return false;
  if (r.status !== 200) throw new Error(r.body.error || `it said ${r.status}`);
  return true;
}
