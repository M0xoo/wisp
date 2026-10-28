// Previews on a wisp Grid: a page the agent left running on this box (localhost:5173) shown at
// its own address, p5173--<handle>.<domain>. The grid's edge signs the user in there and sends
// the request here with the trusted-proxy secret and x-wisp-preview: <port>; this passes it on to
// that port on this box's loopback, websockets (dev servers' live reload) included. Off unless
// the grid set WISP_PREVIEW_URL (it does for boxes, which have a loopback of their own).

import http from 'node:http';
import net from 'node:net';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

// The port asked for, or 0: a real one, never this wisp's own (that would skip its checks).
export function previewPort(req, own) {
  const raw = req.headers['x-wisp-preview'];
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return 0;
  const port = Number(raw);
  return port >= 1 && port <= 65535 && port !== Number(own) ? port : 0;
}

// What the page there sees: Host is localhost:<port> (dev servers refuse other hosts), and
// nothing from the grid or this wisp.
function headersFor(req, port) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-wisp-')) out[k] = v;
  out.host = `localhost:${port}`;
  return out;
}

// A redirect to http://localhost:<port>/x stays on the preview's address: /x.
const local = (port) => new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i');

export function previewRequest(req, res, port) {
  // "localhost": the dev server may listen on 127.0.0.1 or ::1; Node tries both.
  const up = http.request({ host: 'localhost', port, method: req.method, path: req.url, headers: headersFor(req, port) }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    if (typeof out.location === 'string') out.location = out.location.replace(local(port), '') || '/';
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    const refused = err.code === 'ECONNREFUSED';
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page(refused ? `Nothing answers on port ${port} of this computer` : `Port ${port} didn’t answer`, refused ? 'The server the agent started there has stopped, or listens on another port. Ask it to start it again.' : err.message));
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

// A websocket (or any upgrade): the request head as it came, Host rewritten, then both ways.
export function previewUpgrade(req, socket, head, port) {
  const h = headersFor(req, port);
  h.connection = 'Upgrade';
  h.upgrade = req.headers.upgrade;
  const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => [].concat(v).map((x) => `${k}: ${x}`))];
  const up = net.connect({ host: 'localhost', port, autoSelectFamily: true }, () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#888;background:transparent}div{max-width:30em;padding:24px;text-align:center}b{display:block;color:#aaa;margin-bottom:6px}</style><div><b>${title}</b>${text.replace(/[<>&]/g, '')}</div>`;
