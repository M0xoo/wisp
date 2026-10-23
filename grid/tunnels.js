// Computers added to the grid hold a tunnel open to it: wisp on the computer dials out
// (GET /api/computers/:id/tunnel, Upgrade: wisp-tunnel, with its device token) and the grid sends
// it requests over that one connection. It's HTTP/2 the other way round: the grid is the client
// and the computer the server (server/grid-tunnel.js), so requests share it, stream (SSE) and
// keep their own flow control. Nothing listens on the computer and no router needs opening.

import http2 from 'node:http2';

export const TUNNEL_PROTOCOL = 'wisp-tunnel';
const PING_MS = 25_000; // keeps proxies on the way (Caddy, NAT) from dropping an idle tunnel
const WINDOW = 1 << 20;
// Hop-by-hop, or not allowed in HTTP/2.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'http2-settings']);

export function createTunnels({ log = () => {}, onChange = () => {} } = {}) {
  const live = new Map(); // computer id -> { session, since }

  // The computer's upgraded socket: from now on the grid speaks HTTP/2 to it.
  function accept(id, socket, head) {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${TUNNEL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
    if (head?.length) socket.unshift(head);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, PING_MS);
    const session = http2.connect('http://computer', { createConnection: () => socket, settings: { initialWindowSize: WINDOW } });
    const t = { session, since: Date.now() };
    live.get(id)?.session.destroy(); // a computer that reconnected: its new tunnel wins
    live.set(id, t);
    session.on('error', () => {});
    // The computer hung up. The HTTP server's sockets are half-open, so without this the tunnel
    // would count as up until the next ping failed, and the computer show as online meanwhile.
    socket.on('end', () => session.destroy());
    const ping = setInterval(() => session.ping(() => {}), PING_MS);
    ping.unref();
    session.on('close', () => {
      clearInterval(ping);
      if (live.get(id) !== t) return;
      live.delete(id);
      onChange(id, false);
    });
    onChange(id, true);
  }

  // A request for the computer, sent through its tunnel with these headers (req's by default).
  // False when it has none (offline).
  function forward(id, req, res, from = req.headers) {
    const t = live.get(id);
    if (!t || t.session.destroyed) return false;
    const headers = { ':method': req.method, ':path': req.url, ':authority': String(req.headers.host || 'computer') };
    for (const [k, v] of Object.entries(from)) if (!HOP.has(k) && !k.startsWith(':')) headers[k] = v;
    let s;
    try {
      s = t.session.request(headers);
    } catch (err) {
      log(`grid: tunnel ${id}: ${err.message}`);
      return false;
    }
    s.on('response', (h) => {
      const out = {};
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') && !HOP.has(k)) out[k] = v;
      res.writeHead(h[':status'], out);
      s.pipe(res);
    });
    s.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `The computer didn’t answer: ${err.message}` }));
      } else res.destroy();
    });
    s.on('close', () => {
      if (!res.writableEnded && res.headersSent) res.end();
    });
    // The page went away (an event stream closed): so does the request on the computer.
    res.on('close', () => s.destroyed || s.close(http2.constants.NGHTTP2_CANCEL));
    req.pipe(s);
    return true;
  }

  return {
    accept,
    forward,
    online: (id) => !!live.get(id) && !live.get(id).session.destroyed,
    since: (id) => live.get(id)?.since || null,
    close(id) {
      live.get(id)?.session.destroy();
    },
    closeAll() {
      for (const t of live.values()) t.session.destroy();
      live.clear();
    },
  };
}
