// A WebSocket client (RFC 6455) on node:net and node:tls, as Node 20 has no global one and wisp takes
// no dependencies. Text and binary, fragmented or not, ping and pong, the close handshake, a limit on
// what the other side may send, and a clean close on abort. Knows nothing of any channel.
//
//   const ws = await openWs('wss://…', { signal });
//   ws.on('message', (text) => …); ws.on('close', (code, reason) => …);
//   ws.send('hello'); ws.ping(); ws.close();
//
// 'close' fires exactly once, however it ended: 1006 when the connection just went. There is no
// 'error' event: a failure is a close, with what went wrong as its reason. A URL can hold a ticket
// (Slack's does), so nothing here ever repeats one.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEAD = 16 * 1024;
const CLOSE_WAIT_MS = 1000;
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
export const MAX_FRAME = 4 * 1024 * 1024; // of one frame, and of a message put back together

export class Ws extends EventEmitter {
  #sock;
  #buf = Buffer.alloc(0);
  #parts = [];
  #size = 0;
  #kind = 0;
  #max;
  #closing = false;
  #done = false;
  #timer = null;
  #signal;
  #onAbort = () => this.close();
  #why = '';

  // head: what came in behind the handshake.
  constructor(sock, head, { maxFrame = MAX_FRAME, signal = null } = {}) {
    super();
    this.#sock = sock;
    this.#max = maxFrame;
    this.#signal = signal;
    sock.on('error', (err) => (this.#why = err.message));
    sock.on('close', () => this.#finish(1006, this.#why || 'The connection dropped.'));
    sock.on('data', (d) => this.#read(d));
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    if (signal?.aborted) this.close();
    // Not before the caller can listen: the frames in head may well be the first thing it wants.
    if (head.length) setImmediate(() => this.#read(head));
  }

  get open() {
    return !this.#closing && !this.#done;
  }

  send(text) {
    if (this.open) this.#write(OP.text, Buffer.from(String(text), 'utf8'));
    return this.open;
  }

  ping(data = '') {
    if (this.open) this.#write(OP.ping, Buffer.from(data).subarray(0, 125));
    return this.open;
  }

  // Says goodbye and waits for the answer, but not for long.
  close(code = 1000, reason = '') {
    if (this.#closing || this.#done) return;
    this.#sayClose(code, reason);
    this.#timer = setTimeout(() => this.#finish(code, reason), CLOSE_WAIT_MS);
    this.#timer.unref?.();
  }

  // At once, with no goodbye: a connection that has stopped answering.
  destroy(reason = '') {
    this.#finish(1006, reason);
  }

  #sayClose(code, reason) {
    this.#closing = true;
    const text = Buffer.from(String(reason)).subarray(0, 123);
    const body = Buffer.alloc(2 + text.length);
    body.writeUInt16BE(code, 0);
    text.copy(body, 2);
    this.#write(OP.close, body);
  }

  #fail(code, reason) {
    if (!this.#closing) this.#sayClose(code, reason);
    this.#finish(code, reason);
  }

  #finish(code, reason) {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#timer);
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#buf = Buffer.alloc(0);
    this.#parts = [];
    this.#sock.end?.();
    this.#sock.destroy();
    this.emit('close', code, reason);
  }

  // A client's frames are always masked.
  #write(op, body) {
    const n = body.length;
    const ext = n < 126 ? 0 : n < 65536 ? 2 : 8;
    const out = Buffer.alloc(2 + ext + 4 + n);
    out[0] = 0x80 | op;
    out[1] = 0x80 | (ext === 0 ? n : ext === 2 ? 126 : 127);
    if (ext === 2) out.writeUInt16BE(n, 2);
    if (ext === 8) out.writeBigUInt64BE(BigInt(n), 2);
    const mask = randomBytes(4);
    mask.copy(out, 2 + ext);
    for (let i = 0; i < n; i++) out[2 + ext + 4 + i] = body[i] ^ mask[i & 3];
    this.#sock.write(out);
  }

  #read(chunk) {
    if (this.#done) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (!this.#done) {
      const f = this.#frame();
      if (!f) return;
      this.#handle(f);
    }
  }

  // The next whole frame out of the buffer, or null for now. The size is judged by its header, so an
  // oversized frame is refused before any of it is kept.
  #frame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const short = b[1] & 0x7f;
    const head = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0);
    if (b.length < head) return null;
    if (b[0] & 0x70) return this.#fail(1002, 'A reserved bit was set.'), null;
    if (b[1] & 0x80) return this.#fail(1002, 'A server’s frames aren’t masked.'), null;
    const op = b[0] & 0x0f;
    const big = short === 127 ? b.readBigUInt64BE(2) : 0n;
    if (big > BigInt(this.#max)) return this.#fail(1009, 'That frame is too big.'), null;
    const len = short === 126 ? b.readUInt16BE(2) : short === 127 ? Number(big) : short;
    if (len > this.#max) return this.#fail(1009, 'That frame is too big.'), null;
    if (op >= 8 && (len > 125 || !(b[0] & 0x80))) return this.#fail(1002, 'A control frame can’t be long or in pieces.'), null;
    if (b.length < head + len) return null;
    this.#buf = b.subarray(head + len);
    return { fin: !!(b[0] & 0x80), op, body: b.subarray(head, head + len) };
  }

  #handle({ fin, op, body }) {
    if (op === OP.close) return this.#closed(body);
    if (op === OP.ping) return this.open ? this.#write(OP.pong, body) : undefined;
    if (op === OP.pong) return void this.emit('pong', Buffer.from(body));
    if (op !== OP.continuation && op !== OP.text && op !== OP.binary) return this.#fail(1002, 'An opcode nobody defined.');
    if ((op === OP.continuation) === !this.#kind) return this.#fail(1002, op ? 'A new message before the last one ended.' : 'A continuation of nothing.');
    this.#kind ||= op;
    this.#size += body.length;
    if (this.#size > this.#max) return this.#fail(1009, 'That message is too big.');
    this.#parts.push(Buffer.from(body));
    if (!fin) return;
    const whole = Buffer.concat(this.#parts);
    const kind = this.#kind;
    this.#parts = [];
    this.#size = 0;
    this.#kind = 0;
    if (this.#closing) return; // said goodbye: what's still coming in isn't for anyone
    if (kind === OP.binary) return void this.emit('binary', whole);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(whole);
    } catch {
      return this.#fail(1007, 'That text isn’t UTF-8.');
    }
    this.emit('message', text);
  }

  #closed(body) {
    const code = body.length >= 2 ? body.readUInt16BE(0) : 1005;
    const reason = body.length > 2 ? body.subarray(2).toString('utf8') : '';
    if (!this.#closing) this.#sayClose(code === 1005 ? 1000 : code, ''); // the answer to theirs
    this.#finish(code, reason);
  }
}

// → a Ws, once the handshake is done. Rejects if it can't be, or the signal aborts first.
export function openWs(url, { signal = null, headers = {}, maxFrame = MAX_FRAME, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return reject(new Error('A WebSocket URL starts with ws:// or wss://.'));
    if (signal?.aborted) return reject(new Error('Aborted.'));
    const secure = u.protocol === 'wss:';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port) || (secure ? 443 : 80);
    const sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const key = randomBytes(16).toString('base64');
    let got = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.off('data', onData);
      sock.off('close', onClose);
      sock.off('error', onError);
      if (fn === reject) {
        sock.on('error', () => {}); // a late one has nowhere to go
        sock.destroy();
      }
      fn(v);
    };
    const onAbort = () => finish(reject, new Error('Aborted.'));
    const onError = (err) => finish(reject, new Error(`Can’t reach ${u.hostname}: ${err.message}`));
    const onClose = () => finish(reject, new Error(`${u.hostname} closed the connection during the handshake.`));
    const onData = (d) => {
      got = Buffer.concat([got, d]);
      const end = got.indexOf('\r\n\r\n');
      if (end < 0) return got.length > MAX_HEAD ? finish(reject, new Error(`${u.hostname} sent too long a handshake.`)) : undefined;
      const [status, ...lines] = got.subarray(0, end).toString('latin1').split('\r\n');
      const head = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      const code = /^HTTP\/1\.1 (\d{3})/.exec(status)?.[1];
      if (code !== '101') return finish(reject, Object.assign(new Error(`${u.hostname} answered ${code || 'something else'} to the handshake.`), { status: Number(code) || 0 }));
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      if (head.upgrade?.toLowerCase() !== 'websocket' || !/\bupgrade\b/i.test(head.connection || '') || head['sec-websocket-accept'] !== accept) return finish(reject, new Error(`${u.hostname} answered the handshake wrongly.`));
      if (head['sec-websocket-extensions']) return finish(reject, new Error(`${u.hostname} turned on an extension nobody asked for.`));
      sock.setNoDelay?.(true);
      const rest = got.subarray(end + 4);
      const ws = new Ws(sock, rest, { maxFrame, signal });
      finish(resolve, ws);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${u.hostname} didn’t answer in time.`)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    sock.on('error', onError);
    sock.on('close', onClose);
    sock.on('data', onData);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
  });
}
