// A fake Discord on loopback, on the fake Slack's hand-written frames: real HTTP for REST, and a real
// gateway socket with sessions, sequence numbers, resume and heartbeats. Point WISP_DISCORD_API at
// `fake.api`.
//
//   fake.dispatch(t, d)    an event; it waits for a resume if nobody's connected
//   fake.message(o)        MESSAGE_CREATE, with a fresh snowflake → the message
//   fake.interact(o)       INTERACTION_CREATE → the interaction
//   fake.drop()            the socket goes, with no goodbye
//   fake.op(op, d)         a raw gateway op (7 reconnect, 9 invalid session, 1 heartbeat)
//   fake.close(code)       the gateway closes with a code
//   fake.fail(match, reply)  the next REST call matching gets { status, headers, body }
//   fake.deaf = true       heartbeats go unacked
//   fake.revoked = true    REST answers 401, and identify closes with 4004
//   fake.noThreads = code  creating a thread fails with that code
//   fake.posts, callbacks, edits, threads, commands, identifies, resumes, beats, calls: what happened

import http from 'node:http';
import { acceptUpgrades, frame, readFrames } from './fake-slack.mjs';

const EPOCH = 1420070400000n;
let counter = 0;
export const snowflake = (at = Date.now()) => String(((BigInt(at) - EPOCH) << 22n) | BigInt(++counter % 4096));

export class FakeDiscord {
  posts = [];
  callbacks = [];
  edits = [];
  threads = [];
  commands = [];
  identifies = [];
  resumes = [];
  beats = [];
  calls = [];
  closes = [];
  sockets = new Set();
  deaf = false;
  revoked = false;
  noThreads = 0;
  limit = null; // session_start_limit
  heartbeat = 20;
  user = { id: '900', username: 'wisp', bot: true };
  appId = '555555';
  guilds = [{ id: 'G1', unavailable: true }, { id: 'G2', unavailable: true }];
  #fails = [];
  #seq = 0;
  #log = []; // every dispatch, for a resume
  #session = null;

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

  fail(match, reply) {
    this.#fails.push({ match, reply });
  }

  async #http(req, res) {
    let raw = '';
    for await (const c of req) raw += c;
    const path = req.url.replace(/^\/api/, '');
    const route = `${req.method} ${path}`;
    const body = raw ? JSON.parse(raw) : {};
    this.calls.push({ route, at: Date.now(), auth: req.headers.authorization });
    const send = (status, o, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(o === null ? '' : JSON.stringify(o));
    };
    const at = this.#fails.findIndex((f) => route.includes(f.match));
    if (at >= 0) {
      const [{ reply }] = this.#fails.splice(at, 1);
      return send(reply.status || 200, reply.body ?? {}, reply.headers);
    }
    if (this.revoked || req.headers.authorization !== `Bot ${this.token}`) return send(401, { message: '401: Unauthorized', code: 0 });
    let m;
    if (route === 'GET /gateway/bot') return send(200, { url: `ws://127.0.0.1:${this.port}/gateway`, shards: 1, session_start_limit: this.limit || { total: 1000, remaining: 999, reset_after: 1000, max_concurrency: 1 } });
    if ((m = /^PUT \/applications\/(\d+)\/commands$/.exec(route))) {
      this.commands.push({ app: m[1], body });
      return send(200, body);
    }
    if ((m = /^POST \/channels\/([^/]+)\/messages\/([^/]+)\/threads$/.exec(route))) {
      if (this.noThreads) return send(this.noThreads === 50013 ? 403 : 400, { code: this.noThreads, message: 'No thread here' });
      const id = snowflake();
      this.threads.push({ id, channel: m[1], message: m[2], ...body });
      return send(201, { id, name: body.name, type: 11, parent_id: m[1] });
    }
    if ((m = /^POST \/channels\/([^/]+)\/messages$/.exec(route))) {
      const id = snowflake();
      this.posts.push({ ...body, id, channel: m[1] });
      return send(200, { id, channel_id: m[1] });
    }
    if ((m = /^POST \/interactions\/([^/]+)\/([^/]+)\/callback$/.exec(route))) {
      this.callbacks.push({ id: m[1], token: m[2], ...body });
      return send(204, null);
    }
    if ((m = /^PATCH \/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(route))) {
      const id = snowflake();
      this.edits.push({ ...body, id, app: m[1], token: m[2] });
      return send(200, { id, channel_id: 'C1' });
    }
    send(404, { message: 'Unknown route', code: 0 });
  }

  #connected(socket) {
    this.sockets.add(socket);
    const state = {};
    socket.on('close', () => this.sockets.delete(socket));
    const op = (o) => socket.write(frame(1, JSON.stringify(o)));
    socket.on('data', (chunk) => {
      for (const f of readFrames(state, chunk)) {
        if (f.op === 8) {
          this.closes.push(f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005);
          socket.write(frame(8, f.payload));
          socket.end();
        }
        if (f.op !== 1) continue;
        const m = JSON.parse(f.payload.toString());
        if (m.op === 1) {
          this.beats.push(m.d);
          if (!this.deaf) op({ op: 11 });
        }
        if (m.op === 2) {
          this.identifies.push(m.d);
          if (this.revoked) {
            socket.write(frame(8, Buffer.from([0x0f, 0xa4])));
            socket.end();
            continue;
          }
          this.#session = `session-${this.identifies.length}`;
          this.#send('READY', { v: 10, session_id: this.#session, resume_gateway_url: `ws://127.0.0.1:${this.port}/resume`, user: this.user, guilds: this.guilds, application: { id: this.appId } });
        }
        if (m.op === 6) {
          this.resumes.push(m.d);
          if (m.d.session_id !== this.#session) op({ op: 9, d: false });
          else {
            for (const e of this.#log.filter((x) => x.s > m.d.seq)) op(e);
            this.#send('RESUMED', {});
          }
        }
      }
    });
    op({ op: 10, d: { heartbeat_interval: this.heartbeat } });
  }

  #write(o) {
    for (const s of this.sockets) s.write(frame(1, JSON.stringify(o)));
  }

  #send(t, d) {
    const o = { op: 0, s: ++this.#seq, t, d };
    this.#log.push(o);
    this.#write(o);
  }

  dispatch(t, d) {
    this.#send(t, d);
  }

  message(o) {
    const m = { id: snowflake(), type: 0, channel_id: 'C1', guild_id: 'G1', author: { id: 'U1', username: 'me' }, content: '', mentions: [], ...o };
    this.dispatch('MESSAGE_CREATE', m);
    return m;
  }

  interact(o) {
    const d = { id: snowflake(), token: `itoken-${++counter}`, application_id: this.appId, channel_id: 'C1', guild_id: 'G1', ...o };
    this.dispatch('INTERACTION_CREATE', d);
    return d;
  }

  op(op, d) {
    this.#write({ op, d });
  }

  close(code) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    for (const s of this.sockets) {
      s.write(frame(8, b));
      s.end();
    }
  }

  drop() {
    for (const s of this.sockets) s.destroy();
  }
}
