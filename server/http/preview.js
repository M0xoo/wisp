// Previews on a wisp Grid: a page the agent left running here (localhost:5173) shown at its own
// address, p5173--<handle>.<domain> for a box, p5173--<name>--<handle>.<domain> for a computer
// added to the grid. The grid's edge signs the user in there and sends the request on with
// x-wisp-preview: <port>; this passes it to that port on this computer's loopback, websockets
// (dev servers' live reload) included.
//
//   a box       comes through the trusted proxy (server/index.js). Off unless the grid set
//               WISP_PREVIEW_URL (it does for boxes, which have a loopback of their own).
//   a computer  comes through its tunnel (server/grid-tunnel.js), only while Settings →
//               Machines → *Show local pages in previews* is on: its loopback is everything you run.

import http from 'node:http';
import net from 'node:net';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'http2-settings']);

// The port asked for, or 0: a real one, never this wisp's own (that would skip its checks).
export function previewPort(headers, own) {
  const raw = headers['x-wisp-preview'];
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return 0;
  const port = Number(raw);
  return port >= 1 && port <= 65535 && port !== Number(own) ? port : 0;
}

// What the page there sees: Host is localhost:<port> (dev servers refuse other hosts), and
// nothing from the grid or this wisp.
export function previewHeaders(headers, port) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!k.startsWith(':') && !HOP.has(k) && !k.startsWith('x-wisp-')) out[k] = v;
  out.host = `localhost:${port}`;
  return out;
}

// A redirect to http://localhost:<port>/x stays on the preview's address: /x.
export function localRedirect(location, port) {
  if (typeof location !== 'string') return location;
  return location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i'), '') || '/';
}

// The page's answer, minus hop-by-hop headers, its redirects kept on the preview's address.
export function previewAnswer(headers, port) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
  if (out.location) out.location = localRedirect(out.location, port);
  return out;
}

// Asks the page there: "localhost", so a server on 127.0.0.1 or ::1 both answer (Node tries both).
export function askLocal({ method, path, headers, port }, onAnswer, onError) {
  const up = http.request({ host: 'localhost', port, method, path, headers: previewHeaders(headers, port) }, onAnswer);
  up.on('error', onError);
  return up;
}

export function previewRequest(req, res, port) {
  const up = askLocal(
    { method: req.method, path: req.url, headers: req.headers, port },
    (r) => {
      res.writeHead(r.statusCode, previewAnswer(r.headers, port));
      r.pipe(res);
    },
    (err) => {
      if (res.headersSent) return res.destroy();
      const p = failedPage(port, err);
      res.writeHead(p.status, p.headers);
      res.end(p.body);
    },
  );
  res.on('close', () => up.destroy());
  req.pipe(up);
}

// A websocket (or any upgrade) to the page there: the request head as it came, Host rewritten,
// written to a socket on that port. Then the bytes go both ways, the 101 answer included.
export function connectLocal({ method, path, headers, port }, onOpen, onError) {
  const h = previewHeaders(headers, port);
  h.connection = 'Upgrade';
  h.upgrade = headers.upgrade;
  const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => [].concat(v).map((x) => `${k}: ${x}`))];
  const up = net.connect({ host: 'localhost', port, autoSelectFamily: true }, () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    onOpen(up);
  });
  up.on('error', onError);
  return up;
}

export function previewUpgrade(req, socket, head, port) {
  const up = connectLocal(
    { method: req.method, path: req.url, headers: req.headers, port },
    () => {
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    },
    () => socket.destroy(),
  );
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}

// A page saying why, for the frame (title and text are plain text).
export const noticePage = (title, text) => page(title, text);

// Nothing answered on that port: a page saying so, in the frame.
export function failedPage(port, err) {
  const refused = err?.code === 'ECONNREFUSED';
  const title = refused ? `Nothing answers on port ${port} of this computer` : `Port ${port} didn’t answer`;
  const text = refused ? 'The server the agent started there has stopped, or listens on another port. Ask it to start it again.' : String(err?.message || '');
  return { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: page(title, text) };
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title.replace(/[<>&]/g, '')}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#888;background:transparent}div{max-width:30em;padding:24px;text-align:center}b{display:block;color:#aaa;margin-bottom:6px}</style><div><b>${title.replace(/[<>&]/g, '')}</b>${text.replace(/[<>&]/g, '')}</div>`;
