// Computers added to the grid hold a tunnel open to it: wisp on the computer dials out
// (GET /api/computers/:id/tunnel, Upgrade: wisp-tunnel, with its device token) and the grid sends
// it requests over that one connection. It's HTTP/2 the other way round: the grid is the client
// and the computer the server (the grid-tunnel transport, plan §7.2.2), so requests share it,
// stream (SSE) and keep their own flow control. Nothing listens on the computer and no router
// needs opening.

import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export const TUNNEL_PROTOCOL = 'wisp-tunnel';
const PING_MS = 25_000; // keeps proxies on the way (Caddy, NAT) from dropping an idle tunnel
const WINDOW = 1 << 20;
const ASK_MAX = 64 * 1024;
// Hop-by-hop, or not allowed in HTTP/2.
const HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'http2-settings']);

// Cookies a page may set from behind the grid: its own address only. One with Domain= would
// reach the grid's other names (cookie tossing).
export const hostOnly = (v: string | readonly string[] | undefined | null): string[] => ([] as string[]).concat(v ?? []).filter((c) => !/;\s*domain\s*=/i.test(String(c)));

export type HeaderBag = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

interface Live {
  session: ClientHttp2Session;
  since: number;
}

export interface AskOptions {
  method?: string;
  path: string;
  headers?: Record<string, string | number>;
  body?: string;
  timeoutMs?: number;
}

// The request's own pseudo-headers, then what goes on (hop-by-hop and pseudo-headers dropped).
function streamHeaders(req: IncomingMessage, from: HeaderBag): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ':method': req.method ?? 'GET', ':path': req.url ?? '/', ':authority': String(req.headers.host || 'computer') };
  for (const [k, v] of Object.entries(from)) if (v !== undefined && !HOP.has(k) && !k.startsWith(':')) headers[k] = v;
  return headers;
}

const badGateway = (res: ServerResponse, error: string): void => {
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

export function createTunnels({ log = (_m: string) => {}, onChange = (_id: string, _up: boolean) => {} }: { log?: (m: string) => void; onChange?: (id: string, up: boolean) => void } = {}) {
  const live = new Map<string, Live>(); // computer id -> its session
  const up = (id: string): Live | null => {
    const t = live.get(id);
    return t && !t.session.destroyed ? t : null;
  };
  const open = (id: string, headers: OutgoingHttpHeaders, opts?: { endStream: boolean }): ClientHttp2Stream | null => {
    const t = up(id);
    if (!t) return null;
    try {
      return t.session.request(headers, opts);
    } catch (err) {
      log(`grid: tunnel ${id}: ${(err as Error).message}`);
      return null;
    }
  };

  // The computer's upgraded socket: from now on the grid speaks HTTP/2 to it.
  function accept(id: string, socket: Duplex, head?: Buffer): void {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${TUNNEL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
    if (head?.length) socket.unshift(head);
    if (socket instanceof net.Socket) {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, PING_MS);
    }
    const session = http2.connect('http://computer', { createConnection: () => socket, settings: { initialWindowSize: WINDOW, enablePush: false } });
    const t: Live = { session, since: Date.now() };
    live.get(id)?.session.destroy(); // a computer that reconnected: its new tunnel wins
    live.set(id, t);
    session.on('error', () => {});
    // The computer hung up. The HTTP server's sockets are half-open, so without this the tunnel
    // would count as up until the next ping failed, and the computer show as online meanwhile.
    socket.on('end', () => session.destroy());
    // 'close' comes only once the socket has closed, a while after destroy(): a ping due in between
    // would throw from this timer, where nothing catches it, and take the grid down.
    const ping = setInterval(() => {
      if (session.destroyed || session.closed) return clearInterval(ping);
      session.ping(() => {});
    }, PING_MS);
    ping.unref();
    session.on('close', () => {
      clearInterval(ping);
      if (live.get(id) !== t) return;
      live.delete(id);
      onChange(id, false);
    });
    onChange(id, true);
  }

  // The computer is the user's, not ours: what it answers mustn't take the grid down (a status
  // like 000 makes writeHead throw, outside any try) or set cookies for the grid's other names.
  function answer(id: string, s: ClientHttp2Stream, res: ServerResponse, cookies: boolean): void {
    s.on('response', (h) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(h)) if (v !== undefined && !k.startsWith(':') && !HOP.has(k) && k !== 'set-cookie') out[k] = Array.isArray(v) ? v : String(v);
      if (cookies && h['set-cookie']) out['set-cookie'] = hostOnly(h['set-cookie']);
      try {
        res.writeHead(Number(h[':status']), out);
      } catch (err) {
        log(`grid: tunnel ${id}: ${(err as Error).message}`);
        s.close(http2.constants.NGHTTP2_CANCEL);
        if (!res.headersSent) badGateway(res, 'The computer’s answer made no sense.');
        return;
      }
      s.pipe(res);
    });
  }

  // A request for the computer, sent through its tunnel with these headers (req's by default).
  // False when it has none (offline). cookies: let it set them (a preview's page, on its own
  // address), host-only.
  function forward(id: string, req: IncomingMessage, res: ServerResponse, from: HeaderBag = req.headers, { cookies = false }: { cookies?: boolean } = {}): boolean {
    const s = open(id, streamHeaders(req, from));
    if (!s) return false;
    answer(id, s, res, cookies);
    s.on('error', (err) => {
      if (!res.headersSent) badGateway(res, `The computer didn’t answer: ${err.message}`);
      else res.destroy();
    });
    s.on('close', () => {
      if (!res.writableEnded && res.headersSent) res.end();
    });
    // The page went away (an event stream closed): so does the request on the computer.
    res.on('close', () => s.destroyed || s.close(http2.constants.NGHTTP2_CANCEL));
    req.pipe(s);
    return true;
  }

  // A request of the grid's own, not a person's: its answer back here, { status, body } (null
  // offline). Rejects if it can't be asked, or takes longer than timeoutMs. The computer is the
  // user's: what it says is cut off at ASK_MAX.
  function ask(id: string, { method = 'POST', path, headers = {}, body = '', timeoutMs = 30_000 }: AskOptions): Promise<{ status: number; body: string } | null> {
    const t = up(id);
    if (!t) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let s: ClientHttp2Stream;
      try {
        s = t.session.request({ ':method': method, ':path': path, ':authority': 'computer', ...headers });
      } catch (err) {
        return reject(err);
      }
      const timer = setTimeout(() => s.close(http2.constants.NGHTTP2_CANCEL), timeoutMs);
      timer.unref();
      let status = 0;
      let size = 0;
      const chunks: Buffer[] = [];
      s.on('response', (h) => (status = Number(h[':status']) || 0));
      s.on('data', (d: Buffer) => {
        size += d.length;
        if (size <= ASK_MAX) chunks.push(d);
      });
      s.on('error', () => {});
      s.on('close', () => {
        clearTimeout(timer);
        if (!status) return reject(new Error('no answer'));
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
      });
      s.end(body);
    });
  }

  // A websocket for the computer (a preview's live reload): one stream, with the Upgrade it asked
  // for in x-wisp-upgrade (HTTP/2 has no Upgrade header), its bytes both ways once the computer
  // says 200 (the page's own 101 comes inside). False offline.
  function upgrade(id: string, req: IncomingMessage, socket: Duplex, head: Buffer | undefined, from: HeaderBag): boolean {
    const headers = streamHeaders(req, from);
    headers['x-wisp-upgrade'] = String(req.headers.upgrade || 'websocket');
    const s = open(id, headers, { endStream: false });
    if (!s) return false;
    if (head?.length) s.write(head);
    s.on('response', (h) => {
      const status = Number(h[':status']);
      if (status !== 200) {
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ''}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        return s.close(http2.constants.NGHTTP2_CANCEL);
      }
      s.pipe(socket);
      socket.pipe(s);
    });
    s.on('error', () => socket.destroy());
    s.on('close', () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => s.destroyed || s.close(http2.constants.NGHTTP2_CANCEL));
    return true;
  }

  return {
    accept,
    forward,
    ask,
    upgrade,
    online: (id: string): boolean => !!up(id),
    since: (id: string): number | null => live.get(id)?.since || null,
    close(id: string): void {
      live.get(id)?.session.destroy();
    },
    closeAll(): void {
      for (const t of live.values()) t.session.destroy();
      live.clear();
    },
  };
}

export type Tunnels = ReturnType<typeof createTunnels>;
