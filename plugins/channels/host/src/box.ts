// A cloud wisp asking its grid about channels (v1 channels/box.js): which grid, and the URL its
// webhooks go to. The Box secret is fine for this, since the answer only ever reaches this same box.
// HTTP goes out through the `net` service; the env is read once, at setup.

import { createHash } from 'node:crypto';
import type { BoxApi, BoxGrid, Net } from '@wisp-plugin/channels-api';
import { bad } from '@wisp-plugin/channels-api/kit';

type Env = Readonly<Record<string, string | undefined>>;

/** { status, body } as v1 gridJson answered: a broken connection is a 502, no answer in time a 504. */
export async function gridJson(net: Net, url: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await net.fetch(url, {
      method: o.method ?? 'GET',
      headers: { accept: 'application/json', ...(o.body !== undefined && { 'content-type': 'application/json' }), ...o.headers },
      ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
      timeoutMs: o.timeoutMs ?? 30_000,
    });
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'TimeoutError';
    throw Object.assign(new Error(timedOut ? `${new URL(url).host} didn’t answer in time.` : err instanceof Error ? err.message : String(err)), { status: timedOut ? 504 : 502 });
  }
  const text = await r.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { status: r.status, body };
}

const said = (b: Record<string, unknown>, status: number): string => (typeof b['error'] === 'string' ? b['error'] : `it said ${status}`);

export function makeBox(net: Net, env: Env): BoxApi {
  const grid = (): BoxGrid | null => {
    const url = String(env['WISP_GRID_URL'] || '').replace(/\/+$/, '');
    const secret = env['WISP_TRUSTED_PROXY_SECRET'];
    if (!url || !secret || !env['WISP_PUBLIC_URL'] || env['WISP_SANDBOX'] === '1') return null;
    return { grid: url, auth: `Box ${new URL(env['WISP_PUBLIC_URL']).hostname.split('.')[0]} ${secret}` };
  };
  const q = (channel: string): string => `channel=${encodeURIComponent(channel)}`;
  return {
    grid,
    inBox: () => !!env['WISP_GRID_URL'],
    botMark: (token) => createHash('sha256').update(`wisp bot|${token}`).digest('base64url'),
    async channelUrl(box, channel, bot = '', { gone = false } = {}) {
      const r = await gridJson(net, `${box.grid}/api/channels/url?${q(channel)}${bot ? `&bot=${encodeURIComponent(bot)}` : ''}${gone ? '&gone=1' : ''}`, { headers: { authorization: box.auth }, timeoutMs: 10_000 });
      if (r.status === 404 || r.status === 401) return null;
      if (r.status !== 200 || !(r.body['url'] || r.body['address'])) throw new Error(said(r.body, r.status));
      return r.body as { url?: string; address?: string; dropped?: number; held?: boolean };
    },
    async rotateUrl(box, channel) {
      const r = await gridJson(net, `${box.grid}/api/channels/url/rotate?${q(channel)}`, { method: 'POST', headers: { authorization: box.auth }, timeoutMs: 10_000 });
      if (r.status !== 200 || !(r.body['url'] || r.body['address'])) throw bad(`The grid didn’t rotate it: ${said(r.body, r.status)}.`, 502);
      return r.body as { url?: string; address?: string };
    },
    async mailReply(box, { replyTo, subject, text }) {
      const r = await gridJson(net, `${box.grid}/api/channels/mail/reply`, { method: 'POST', headers: { authorization: box.auth }, body: { replyTo, subject, text }, timeoutMs: 20_000 });
      if (r.status !== 200) throw new Error(typeof r.body['error'] === 'string' ? r.body['error'] : `the grid said ${r.status}`);
      return r.body as { messageId?: string };
    },
    async setChannelKey(box, channel, key, linked) {
      const r = await gridJson(net, `${box.grid}/api/channels/url/key?${q(channel)}`, { method: 'POST', headers: { authorization: box.auth }, body: { key, linked }, timeoutMs: 10_000 });
      if (r.status === 404 || r.status === 401) return false;
      if (r.status !== 200) throw new Error(said(r.body, r.status));
      return true;
    },
  };
}
