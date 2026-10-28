// This computer's end of a grid tunnel (grid/tunnels.js): dial out to the grid with the device
// token, upgrade the connection, then serve HTTP/2 on it. Each request the grid sends is handed to
// wisp here on its loopback, as if from a page on this computer: the grid has already checked
// that it's you asking (your device or your browser, signed in to your account).
//
// A stream with x-wisp-preview: <port> is a preview of a page on this computer (http/preview.js),
// passed to that port only while previews() says so; with x-wisp-upgrade it's a websocket, its
// bytes carried both ways on the stream.
//
// It dials again when the connection drops (Wi-Fi, sleep, a grid restart), and gives up only when
// the grid says this computer or device is gone.

import http from 'node:http';
import http2 from 'node:http2';
import { target } from './grid-client.js';
import { askLocal, connectLocal, failedPage, noticePage, previewAnswer, previewPort } from './http/preview.js';

export const TUNNEL_PROTOCOL = 'wisp-tunnel';
const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const IDLE_MS = 70_000; // the grid pings every 25 s: this long without a byte, the tunnel is dead
const WINDOW = 1 << 20;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'http2-settings']);

// url: the grid's own address. onState({ state: 'connecting'|'online'|'retrying'|'gone', error }).
// previews(): whether pages on this computer may be shown through the grid (off by default).
export function dialTunnel({ url, id, token, port, previews = () => false, onState = () => {} }) {
  let closed = false;
  let attempt = 0;
  let timer = null;
  let req = null;
  let socket = null;

  const state = (s, error = '') => !closed && onState({ state: s, error });

  // Each stream: one request for wisp here.
  const h2 = http2.createServer({ settings: { initialWindowSize: WINDOW } });
  h2.on('session', (s) => {
    s.setTimeout(IDLE_MS, () => s.destroy());
    s.on('error', () => {});
    // Online once the grid speaks HTTP/2 on it, not merely once the socket upgraded.
    s.once('remoteSettings', () => state('online'));
  });
  h2.on('stream', (stream, headers) => {
    if (headers['x-wisp-preview'] !== undefined) return preview(stream, headers);
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!k.startsWith(':') && !HOP.has(k)) out[k] = v;
    // As a page here would: this computer's own host, and no Origin (the grid checked that one).
    out.host = `127.0.0.1:${port}`;
    delete out.origin;
    const up = http.request({ host: '127.0.0.1', port, method: headers[':method'], path: headers[':path'], headers: out }, (r) => {
      const rh = { ':status': r.statusCode };
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) rh[k] = v;
      if (stream.destroyed) return r.destroy();
      try {
        stream.respond(rh);
      } catch {
        return r.destroy();
      }
      r.pipe(stream);
    });
    up.on('error', (err) => {
      if (stream.destroyed) return;
      if (!stream.headersSent) stream.respond({ ':status': 502, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ error: `wisp here didn’t answer: ${err.message}` }));
    });
    stream.on('error', () => up.destroy());
    stream.on('close', () => up.destroy());
    stream.pipe(up);
  });

  function preview(stream, headers) {
    const fail = (status, body, type = 'application/json') => {
      if (stream.destroyed) return;
      if (!stream.headersSent) stream.respond({ ':status': status, 'content-type': type, 'cache-control': 'no-store' });
      stream.end(body);
    };
    stream.on('error', () => {});
    const p = previewPort(headers, port);
    if (!previews()) {
      const error = 'This computer doesn’t show its local pages through the grid. Turn on Settings → Machines → Show local pages in previews there.';
      return /text\/html/.test(String(headers.accept || '')) ? fail(403, noticePage('Local pages are private here', error), 'text/html; charset=utf-8') : fail(403, JSON.stringify({ error }));
    }
    if (!p) return fail(404, JSON.stringify({ error: 'not found' }));
    const ask = { method: headers[':method'], path: headers[':path'], headers, port: p };
    if (headers['x-wisp-upgrade']) {
      const up = connectLocal(
        { ...ask, headers: { ...headers, upgrade: headers['x-wisp-upgrade'] } },
        () => {
          if (stream.destroyed) return up.destroy();
          stream.respond({ ':status': 200 });
          up.pipe(stream);
          stream.pipe(up);
        },
        (err) => fail(502, JSON.stringify({ error: err.message })),
      );
      stream.on('close', () => up.destroy());
      return;
    }
    const up = askLocal(
      ask,
      (r) => {
        if (stream.destroyed) return r.destroy();
        try {
          stream.respond({ ':status': r.statusCode, ...previewAnswer(r.headers, p) });
        } catch {
          return r.destroy();
        }
        r.pipe(stream);
      },
      (err) => {
        const f = failedPage(p, err);
        fail(f.status, f.body, f.headers['content-type']);
      },
    );
    stream.on('close', () => up.destroy());
    stream.pipe(up);
  }

  function retry(error) {
    if (closed) return;
    socket?.destroy();
    socket = null;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    state('retrying', error);
    timer = setTimeout(dial, wait);
    timer.unref?.();
  }

  function dial() {
    if (closed) return;
    state('connecting');
    const { lib, opts } = target(`${url}/api/computers/${id}/tunnel`);
    req = lib.request({ ...opts, path: `/api/computers/${id}/tunnel`, method: 'GET', headers: { connection: 'Upgrade', upgrade: TUNNEL_PROTOCOL, authorization: `Bearer ${token}` }, timeout: 20_000 });
    req.on('upgrade', (res, sock, head) => {
      if (closed) return sock.destroy();
      socket = sock;
      attempt = 0;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 25_000);
      sock.setTimeout(0);
      if (head?.length) sock.unshift(head);
      // Over https the socket is TLS with no ALPN (it was HTTP/1.1 until the upgrade): the HTTP/2
      // server would call that an unknown protocol and drop it after 10 s. It is HTTP/2 now.
      if (sock.encrypted) sock.alpnProtocol = 'h2';
      sock.on('close', () => retry('The connection to the grid dropped.'));
      sock.on('error', () => {});
      h2.emit('connection', sock);
    });
    // Not upgraded: the grid said why. 401/404: this device or computer is gone; don't keep asking.
    req.on('response', (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let msg = '';
        try {
          msg = JSON.parse(t).error || '';
        } catch {}
        if (res.statusCode === 401 || res.statusCode === 404) {
          state('gone', msg || 'The grid doesn’t know this computer any more.');
          closed = true;
          return;
        }
        retry(msg || `The grid said ${res.statusCode}.`);
      });
    });
    req.on('timeout', () => req.destroy(new Error('The grid didn’t answer in time.')));
    req.on('error', (err) => retry(err.message));
    req.end();
  }

  dial();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      req?.destroy();
      socket?.destroy();
      h2.close();
    },
  };
}
