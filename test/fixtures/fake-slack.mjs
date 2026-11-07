// A WebSocket written out by hand, frame by frame, so the client in server/channels/ws.js is tested
// against something that shares no code with it; and on that, a fake Slack: real HTTP for the Web API
// and a real socket for Socket Mode, on loopback. Point WISP_SLACK_API at `fake.api`.
//
//   fake.event({ type, … })   an event in an envelope; → { envelope_id, event_id }
//   fake.envelope(obj)        any envelope as it is (the same one twice is a retry)
//   fake.drop()               the connection goes, with no goodbye
//   fake.disconnect(reason)   Slack's own `disconnect` message
//   fake.fail(method, reply)  the next call of method gets { status, headers, body }, or with
//                             { reset: true } its connection is cut and it gets nothing
//   fake.revoked = true       every token stops working
//   fake.noCustomize = true   the bot has no chat:write.customize
//   fake.deaf = true         pings go unanswered, and the socket stays up
//   fake.silent()            a new connection never says hello
//   fake.posted, fake.acks, fake.calls, fake.opens: what happened

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

export const acceptKey = (key) => createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

// A server's frame. mask, rsv, fin and len (what the header claims) are there to break the rules.
export function frame(op, payload = '', { fin = true, mask = false, rsv = 0, len } = {}) {
  const body = Buffer.from(payload);
  const n = len ?? body.length;
  const head = n < 126 ? [n] : n < 65536 ? [126, n >> 8, n & 255] : [127, ...Buffer.from(BigInt(n).toString(16).padStart(16, '0'), 'hex')];
  const key = mask ? randomBytes(4) : Buffer.alloc(0);
  const out = Buffer.from(body);
  if (mask) for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  head[0] |= mask ? 0x80 : 0;
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | op, ...head]), key, out]);
}

// What a client sent, as whole frames. Throws on one that isn't masked: a client's always are.
export function readFrames(state, chunk) {
  state.buf = Buffer.concat([state.buf || Buffer.alloc(0), chunk]);
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return out;
    let n = b[1] & 0x7f;
    let at = 2;
    if (n === 126) {
      if (b.length < 4) return out;
      n = b.readUInt16BE(2);
      at = 4;
    } else if (n === 127) {
      if (b.length < 10) return out;
      n = Number(b.readBigUInt64BE(2));
      at = 10;
    }
    if (!(b[1] & 0x80)) throw new Error('a client frame without a mask');
    if (b.length < at + 4 + n) return out;
    const key = b.subarray(at, at + 4);
    const payload = Buffer.from(b.subarray(at + 4, at + 4 + n));
    for (let i = 0; i < n; i++) payload[i] ^= key[i & 3];
    out.push({ fin: !!(b[0] & 0x80), op: b[0] & 0x0f, payload });
    state.buf = b.subarray(at + 4 + n);
  }
}

// An http server that answers the upgrade by hand. onSocket(socket, req).
export function acceptUpgrades(server, onSocket, { reply } = {}) {
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    socket.write(reply?.(req) ?? `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`);
    onSocket(socket, req);
  });
}

export class FakeSlack {
  posted = [];
  acks = [];
  calls = [];
  closes = [];
  sockets = new Set();
  opens = 0;
  revoked = false;
  noCustomize = false;
  bot = { user_id: 'UBOT', bot_id: 'BBOT', user: 'wisp', team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/' };
  #fails = new Map();
  #next = 1000;
  #ts = 1;
  #hello = true;

  async start() {
    this.server = http.createServer((req, res) => this.#http(req, res));
    acceptUpgrades(this.server, (socket) => this.#connected(socket));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.api = `http://127.0.0.1:${this.port}/api`;
    return this;
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections?.();
    this.server.close();
  }

  fail(method, reply) {
    this.#fails.set(method, [...(this.#fails.get(method) || []), reply]);
  }

  // A connection that never says hello.
  silent(on = true) {
    this.#hello = !on;
  }

  async #http(req, res) {
    let raw = '';
    for await (const c of req) raw += c;
    const method = req.url.split('/').pop().split('?')[0];
    const body = raw ? JSON.parse(raw) : {};
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    this.calls.push({ method, token, body });
    const send = (status, o, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(o));
    };
    const fail = this.#fails.get(method)?.shift();
    if (fail?.reset) return req.socket.destroy();
    if (fail) return send(fail.status || 200, fail.body || {}, fail.headers);
    if (this.revoked) return send(200, { ok: false, error: 'token_revoked' });
    const app = method === 'apps.connections.open';
    if (!(app ? token.startsWith('xapp-') : token.startsWith('xoxb-'))) return send(200, { ok: false, error: 'invalid_auth' });
    if (app) return send(200, { ok: true, url: `ws://127.0.0.1:${this.port}/link?ticket=secret-ticket-${++this.opens}` });
    if (method === 'auth.test') return send(200, { ok: true, ...this.bot });
    if (method === 'chat.postMessage') {
      if (this.noCustomize && (body.username || body.icon_emoji)) return send(200, { ok: false, error: 'missing_scope' });
      const ts = `${Math.floor(Date.now() / 1000)}.${String(this.#ts++).padStart(6, '0')}`;
      this.posted.push({ ...body, ts });
      return send(200, { ok: true, channel: body.channel, ts });
    }
    send(200, { ok: false, error: 'unknown_method' });
  }

  #connected(socket) {
    this.sockets.add(socket);
    const state = {};
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk) => {
      for (const f of readFrames(state, chunk)) {
        if (f.op === 9 && !this.deaf) socket.write(frame(10, f.payload));
        if (f.op === 8) {
          this.closes.push(f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005);
          socket.write(frame(8, f.payload));
          socket.end();
        }
        if (f.op === 1) {
          const m = JSON.parse(f.payload.toString());
          if (m.envelope_id) this.acks.push(m.envelope_id);
        }
      }
    });
    if (this.#hello) socket.write(frame(1, JSON.stringify({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A1' } })));
  }

  #write(o) {
    const text = JSON.stringify(o);
    for (const s of this.sockets) s.write(frame(1, text));
  }

  envelope(env) {
    this.#write(env);
    return env;
  }

  // The envelope is returned, so a test can send the same one again (a retry).
  event(event, { event_id, ...more } = {}) {
    const id = ++this.#next;
    return this.envelope({ envelope_id: `env-${id}`, type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '', payload: { type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: event_id || `Ev${id}`, event_time: Math.floor(Date.now() / 1000), event }, ...more });
  }

  disconnect(reason = 'refresh_requested') {
    this.#write({ type: 'disconnect', reason, debug_info: { host: 'fake' } });
  }

  drop() {
    for (const s of this.sockets) s.destroy();
  }
}
