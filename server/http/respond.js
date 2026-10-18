// Writing responses and reading request bodies. The API speaks JSON; a few routes stream.

const MAX_BODY = 2e6;

export function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => {
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
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(frame);
    },
  };
}
