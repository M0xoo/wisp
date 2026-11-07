// POST /api/channels/inbound: a channel's message that wisp Grid held while this box slept
// (grid/inbox.js). Past wisp's guard this is one more request from the proxy, and the proxy also
// carries signed-in people: only the grid's delivery has the mark, which the edge strips from
// everything else (grid/server.js, proxy()). The channel then verifies the message itself.

import { boxGrid } from '../channels/box.js';
import { bad } from '../util.js';

export const CHANNEL_INBOUND = '/api/channels/inbound';

export function register(r, app) {
  r.route('POST', '/channels/inbound', async (c) => {
    if (!boxGrid() || !app.proxy?.via(c.req) || c.req.headers['x-wisp-proxy-via'] !== 'inbox') return c.send(403, { error: 'From wisp Grid only.' });
    const { channel, headers, body, dropped } = await c.body();
    if (typeof channel !== 'string' || typeof body !== 'string') throw bad('channel and body are needed.');
    const ch = Object.hasOwn(app.remote.channels, channel) ? app.remote.channels[channel] : null;
    if (!ch) return c.send(404, { error: 'No such channel.' });
    if (dropped > 0) await ch.dropped(dropped);
    const out = await ch.inbound(Buffer.from(body, 'base64'), headers && typeof headers === 'object' ? headers : {});
    c.send(out.status, out.body);
  });
}
