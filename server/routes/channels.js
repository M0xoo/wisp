// POST /api/channels/inbound: a channel's message that wisp Grid held while this box slept
// (grid/inbox.js). Past wisp's guard this is one more request from the proxy, and the proxy also
// carries signed-in people: only the grid's delivery has the mark, which the edge strips from
// everything else (grid/server.js, proxy()). The channel then verifies the message itself.
// POST /api/channels/rotate: this cloud wisp replaces its inbound URL. Telegram is told the new one;
// Slack can't be, so it comes back in the answer for the app's settings.
// POST /api/channels/routed: a message the grid routed to this computer (grid/route.js), through its
// tunnel only. x-wisp-tunnel says it came that way, which nothing else on this computer can say, and
// the grid drops x-wisp-route from anything a signed-in person sends down the same tunnel.

import { boxGrid } from '../channels/box.js';
import { fromTunnel } from '../grid-tunnel.js';
import { bad } from '../util.js';

export const CHANNEL_INBOUND = '/api/channels/inbound';

export function register(r, app) {
  r.route('POST', '/channels/inbound', async (c) => {
    if (!boxGrid() || !app.proxy?.via(c.req) || c.req.headers['x-wisp-proxy-via'] !== 'inbox') return c.send(403, { error: 'From wisp Grid only.' });
    const { channel, headers, body, at, dropped, verified } = await c.body();
    if (typeof channel !== 'string' || typeof body !== 'string') throw bad('channel and body are needed.');
    const ch = Object.hasOwn(app.remote.channels, channel) ? app.remote.channels[channel] : null;
    if (!ch) return c.send(404, { error: 'No such channel.' });
    const out = await ch.inbound(Buffer.from(body, 'base64'), headers && typeof headers === 'object' ? headers : {}, { at: Number(at) || 0, verified: verified === true });
    // Only past the channel's check: the grid clears its count on a 2xx, so anything else comes back.
    if (dropped > 0 && out.status >= 200 && out.status < 300) await ch.dropped(dropped);
    c.send(out.status, out.body);
    out.after?.(); // work that answers the sender: the grid has to have this 2xx first (grid/mail.js)
  });

  r.route('POST', '/channels/routed', async (c) => {
    if (!fromTunnel(c.req) || c.req.headers['x-wisp-route'] !== 'grid') return c.send(403, { error: 'From wisp Grid only.' });
    const b = await c.body();
    if (typeof b.text !== 'string' || typeof b.thread !== 'string' || typeof b.id !== 'string') throw bad('text, thread and id are needed.');
    const out = await app.remote.channels.routed.take(b);
    c.send(out.status, out.body);
  });

  // A channel URL that leaked: Settings has nothing for this yet, it's for the API and the agent.
  r.route('POST', '/channels/rotate', async (c) => {
    const { channel } = await c.body();
    const ch = typeof channel === 'string' && Object.hasOwn(app.remote.channels, channel) ? app.remote.channels[channel] : null;
    if (!ch) return c.send(404, { error: 'No such channel.' });
    const out = await ch.rotate();
    c.send(out.status, out.body);
  });
}
