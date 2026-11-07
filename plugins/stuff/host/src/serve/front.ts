// An app's own origin (v1 services/apps.js's per-app server), as a child process the stuff plugin
// starts through the proc service: plugins never listen themselves, and a process the kernel spawned
// is owned by the plugin's scope (killed with it) and sandboxed on a grid box like any other. It knows
// nothing of My Stuff: each request goes to the plugin as one JSON line on stdout, and the answer
// comes back on stdin, either a body or a file of the app's folder to stream. The plugin decides
// everything (which host, which file, which CSP, the database); this only moves bytes.
//
// argv[2]: { ports: number[] } (tried in order, on 127.0.0.1). Out: { listening: port | 0 }, then
// { req, method, url, host, contentType, origin, body, tooBig? }. In: { req, status, headers, body? | file? }.

import fs from 'node:fs';
import http from 'node:http';
import { pipeline } from 'node:stream';
import { jsonLines, line } from '../lines.ts';

const BODY_LIMIT = 1024 * 1024;
const send = (msg: unknown): void => void process.stdout.write(line(msg));
const { ports } = JSON.parse(process.argv[2] ?? '{}') as { ports?: number[] };
const pending = new Map<number, { req: http.IncomingMessage; res: http.ServerResponse }>();
let seq = 0;

const server = http.createServer((req, res) => {
  const id = ++seq;
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > BODY_LIMIT) tooBig = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    pending.set(id, { req, res });
    const h = (k: string): string => String(req.headers[k] ?? '');
    send({ req: id, method: req.method, url: req.url, host: h('host'), contentType: h('content-type'), origin: req.headers.origin, body: tooBig ? '' : Buffer.concat(chunks).toString('utf8'), ...(tooBig && { tooBig }) });
  });
  // an early close drops the answer; the plugin's reply then finds nothing to write to
  res.on('close', () => pending.delete(id));
});

interface Reply {
  req: number;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  file?: string;
}

function answer(r: Reply): void {
  const p = pending.get(r.req);
  if (!p) return;
  pending.delete(r.req);
  const { req, res } = p;
  if (r.file === undefined) {
    res.writeHead(r.status, r.headers);
    res.end(req.method === 'HEAD' ? undefined : r.body);
    return;
  }
  fs.stat(r.file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found in this app.');
      return;
    }
    res.writeHead(r.status, { ...r.headers, 'content-length': String(st.size) });
    if (req.method === 'HEAD') return void res.end();
    // pipeline, not pipe: a client that goes early closes the file too, or Windows keeps the folder.
    pipeline(fs.createReadStream(r.file as string), res, () => {});
  });
}

process.stdin.on('data', jsonLines((m) => answer(m as unknown as Reply)));
// the plugin went: so does its app
process.stdin.on('end', () => process.exit(0));

async function listen(): Promise<number> {
  for (const port of ports ?? []) {
    const ok = await new Promise<boolean>((resolve) => {
      const busy = (): void => resolve(false);
      server.once('error', busy);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', busy);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  return 0;
}

send({ listening: await listen() });
