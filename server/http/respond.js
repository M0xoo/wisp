// Writing responses and reading request bodies. The API speaks JSON; a few routes stream.

import zlib from 'node:zlib';

const MAX_BODY = 2e6;
// Bigger answers go gzipped to a client that takes it. The task list is hundreds of KB and the
// phone gets it through an SSH tunnel; level 1 is most of the saving (about 6x) for little CPU,
// and off the event loop: a full session can be megabytes.
const GZIP_MIN = 8 * 1024;

export function send(res, status, body) {
  const json = JSON.stringify(body);
  if (json === undefined || json.length < GZIP_MIN || !/\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(json);
  }
  res.gzipping = true; // answered: the headers go out with the compressed body
  zlib.gzip(json, { level: 1 }, (err, gz) => {
    if (err) {
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(json);
    }
    res.writeHead(status, { 'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'accept-encoding' });
    res.end(gz);
  });
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
