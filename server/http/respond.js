// Writing responses and reading request bodies. The API speaks JSON; a few routes stream.

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAX_BODY = 2e6;
// Bigger answers go compressed to a client that takes it. The task list is hundreds of KB and the
// phone gets it through an SSH tunnel. Brotli at quality 4 when the client takes it (every browser
// does): smaller than gzip at level 1 and as fast (a 2 MB task: 134 KB in 5 ms, against 559 KB in
// 10 ms), else gzip at level 1; both off the event loop, since a full session can be megabytes.
const GZIP_MIN = 8 * 1024;
const BROTLI = (size) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });

// The encoding to answer with: br, gzip or none.
export const encodingFor = (req) => {
  const ae = req?.headers['accept-encoding'] || '';
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
};

// A JSON answer made once and sent again while it holds (the task list): its text, ETag and
// compressed copies are kept on it.
const PREPARED = Symbol('prepared');
export const prepared = (body) => ({ [PREPARED]: true, json: JSON.stringify(body), etag: null, out: {} });

export function send(res, status, body) {
  const p = body?.[PREPARED] ? body : null;
  const json = p ? p.json : JSON.stringify(body);
  // A big read answered again unchanged (a task opened again, the lists after a reconnect): the
  // browser keeps the last answer and asks with If-None-Match, so the tunnel carries a 304
  // instead of the body. no-cache: it always asks; private: nothing in between keeps it.
  const req = res.req;
  if (status === 200 && json !== undefined && json.length >= GZIP_MIN && req?.method === 'GET') {
    const etag = p?.etag || `W/"${crypto.createHash('sha1').update(json).digest('base64url')}"`;
    if (p) p.etag = etag;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
  }
  const enc = json !== undefined && json.length >= GZIP_MIN && encodingFor(req);
  if (!enc) {
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(json);
  }
  res.gzipping = true; // answered: the headers go out with the compressed body
  const done = (err, out) => {
    if (!err && p) p.out[enc] = out;
    if (err) {
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(json);
    }
    res.writeHead(status, { 'content-type': 'application/json', 'content-encoding': enc, vary: 'accept-encoding' });
    res.end(out);
  };
  if (p?.out[enc]) return done(null, p.out[enc]);
  if (enc === 'br') zlib.brotliCompress(json, BROTLI(Buffer.byteLength(json)), done);
  else zlib.gzip(json, { level: 1 }, done);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      data += c;
      if (data.length > MAX_BODY) {
        // Stop buffering: the rest of the body is dropped, not held in memory.
        tooLarge = true;
        data = '';
        reject(Object.assign(new Error('body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
  });
}

// A file on disk, with byte ranges (a video seeks by asking for one). `headers`: more of them,
// e.g. a content-disposition for a download.
export function sendFile(req, res, file, type, headers = {}) {
  const { size } = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  fs.createReadStream(file).pipe(res);
}

// Pass a machine's raw response (images, markdown, uploads) straight through.
export function pipeFrom(res, r) {
  const headers = { 'content-type': r.headers['content-type'] || 'application/octet-stream' };
  if (r.headers['content-length']) headers['content-length'] = r.headers['content-length'];
  res.writeHead(r.statusCode, headers);
  r.pipe(res);
}

// Server-sent events: every open /api/events stream gets every broadcast.
export function eventStream() {
  const clients = new Set();
  return {
    clients,
    attach(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      // Another wisp relaying this one's events (a cloud computer seen from your desktop): it
      // doesn't count as someone looking (GET /api/status clients).
      res.relay = req.headers['x-wisp-relay'] === '1';
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    // fromMachine: an event relayed from one of this wisp's machines. Not sent on to another wisp:
    // when that wisp is the machine it came from (two that list each other), it would come back.
    broadcast(event, data, { fromMachine = false } = {}) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) if (!(fromMachine && res.relay)) res.write(frame);
    },
  };
}
