// Previews on a wisp Grid (v1 server/http/preview.js): a page the agent left running here (localhost:5173)
// shown at its own address, p5173--<handle>.<domain>. The grid's edge signs the user in and sends the
// request on with x-wisp-preview: <port>; this passes it to that port on this computer's loopback,
// websockets (dev servers' live reload) included.
//   a box       comes through the trusted proxy; off unless the grid set WISP_PREVIEW_URL.
//   a computer  comes through its tunnel, only while *Show local pages in previews* is on.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'http2-settings']);

type Headers = Record<string, string | string[] | undefined>;

/** The port asked for, or 0: a real one, never this wisp's own (that would skip its checks). */
export function previewPort(headers: IncomingHttpHeaders, own: number): number {
  const raw = headers['x-wisp-preview'];
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return 0;
  const port = Number(raw);
  return port >= 1 && port <= 65535 && port !== Number(own) ? port : 0;
}

/** What the page sees: Host is localhost:<port> (dev servers refuse other hosts), nothing from wisp. */
export function previewHeaders(headers: IncomingHttpHeaders, port: number): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) if (!k.startsWith(':') && !HOP.has(k) && !k.startsWith('x-wisp-')) out[k] = v;
  out['host'] = `localhost:${port}`;
  return out;
}

/** A redirect to http://localhost:<port>/x stays on the preview's address: /x. */
export function localRedirect(location: string, port: number): string {
  return location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i'), '') || '/';
}

export function previewAnswer(headers: IncomingHttpHeaders, port: number): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
  if (typeof out['location'] === 'string') out['location'] = localRedirect(out['location'], port);
  return out;
}

const escape = (s: string): string => s.replace(/[<>&]/g, '');
const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#888;background:transparent}div{max-width:30em;padding:24px;text-align:center}b{display:block;color:#aaa;margin-bottom:6px}</style><div><b>${escape(title)}</b>${escape(text)}</div>`;

export const noticePage = page;

/** Nothing answered on that port: a page saying so, in the frame. */
export function failedPage(port: number, err: NodeJS.ErrnoException | undefined): { status: number; headers: Record<string, string>; body: string } {
  const refused = err?.code === 'ECONNREFUSED';
  const title = refused ? `Nothing answers on port ${port} of this computer` : `Port ${port} didn’t answer`;
  const text = refused ? 'The server the agent started there has stopped, or listens on another port. Ask it to start it again.' : String(err?.message ?? '');
  return { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: page(title, text) };
}

/** "localhost", so a server on 127.0.0.1 or ::1 both answer (Node tries both). */
export function previewRequest(req: IncomingMessage, res: ServerResponse, port: number): void {
  const up = http.request({ host: 'localhost', port, method: req.method, path: req.url, headers: previewHeaders(req.headers, port) }, (r) => {
    res.writeHead(r.statusCode ?? 502, previewAnswer(r.headers, port));
    r.pipe(res);
  });
  up.on('error', (err: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const p = failedPage(port, err);
    res.writeHead(p.status, p.headers);
    res.end(p.body);
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** A websocket (any upgrade): the request head as it came, Host rewritten, then bytes both ways. */
export function previewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer | undefined, port: number): void {
  const h = previewHeaders(req.headers, port);
  h['connection'] = 'Upgrade';
  h['upgrade'] = req.headers.upgrade;
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (v === undefined ? [] : [v].flat().map((x) => `${k}: ${x}`)))];
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
