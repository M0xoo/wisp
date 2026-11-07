// Writing answers and reading request bodies (v1 server/http/respond.js). The API speaks JSON; a few
// routes stream. Big JSON answers go compressed (brotli q4, else gzip 1, both off the event loop) with a
// weak ETag, so an unchanged re-read over the phone's SSH tunnel costs a 304 instead of the body.
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import zlib from 'node:zlib';

export const MAX_BODY = 2e6;
/** below this a JSON answer goes as is: compressing costs more than it saves */
export const COMPRESS_MIN = 8 * 1024;

const brotliOpts = (size: number): zlib.BrotliOptions => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });

export type Encoding = 'br' | 'gzip';

/** The encoding to answer with, from Accept-Encoding: br (every browser), gzip, or none. */
export function encodingFor(req: Pick<IncomingMessage, 'headers'> | undefined): Encoding | null {
  const ae = String(req?.headers['accept-encoding'] ?? '');
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
}

const PREPARED: unique symbol = Symbol('prepared');

/** A JSON answer made once and sent again while it holds (the task list): text, ETag and compressed copies kept. */
export interface Prepared {
  readonly [PREPARED]: true;
  readonly json: string;
  etag: string | null;
  readonly out: Partial<Record<Encoding, Buffer>>;
}

export const prepared = (body: unknown): Prepared => ({ [PREPARED]: true, json: JSON.stringify(body), etag: null, out: {} });
const isPrepared = (b: unknown): b is Prepared => typeof b === 'object' && b !== null && PREPARED in b;

/** Marks a response whose compressed body is on its way: an error after this can't send a JSON error. */
export const answering = new WeakSet<ServerResponse>();

export const etagOf = (text: string): string => `W/"${crypto.createHash('sha1').update(text).digest('base64url')}"`;

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const p = isPrepared(body) ? body : null;
  const json = p ? p.json : JSON.stringify(body);
  const req = res.req as IncomingMessage | undefined;
  const big = json !== undefined && json.length >= COMPRESS_MIN;
  if (status === 200 && big && req?.method === 'GET') {
    // no-cache: the browser always asks again; private: nothing in between keeps it
    const etag = p?.etag ?? etagOf(json);
    if (p) p.etag = etag;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
  }
  const enc = big ? encodingFor(req) : null;
  const type = { ...headers, 'content-type': 'application/json' };
  if (!enc || json === undefined) {
    res.writeHead(status, type);
    res.end(json);
    return;
  }
  answering.add(res);
  const done = (err: Error | null, out: Buffer): void => {
    if (err) {
      res.writeHead(status, type);
      res.end(json);
      return;
    }
    if (p) p.out[enc] = out;
    res.writeHead(status, { ...type, 'content-encoding': enc, vary: 'accept-encoding' });
    res.end(out);
  };
  const cached = p?.out[enc];
  if (cached) done(null, cached);
  else if (enc === 'br') zlib.brotliCompress(json, brotliOpts(Buffer.byteLength(json)), done);
  else zlib.gzip(json, { level: 1 }, done);
}

/** An HTTP refusal: a route throws it and the edge answers `{error}` with its status (v1's `bad`). */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (message: string, status = 400): HttpError => new HttpError(status, message);

/** The raw body, at most `max` bytes: past it the rest is dropped as it comes, not held. */
export function readRaw(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > max) {
        tooLarge = true;
        chunks = [];
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks)); // decoded once at the end: a chunk can split a UTF-8 character
    });
    req.on('error', reject);
  });
}

export async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const data = (await readRaw(req, max)).toString('utf8');
  if (!data) return {};
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

/** A file on disk with byte ranges (a video seeks by asking for one). */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string, headers: Record<string, string> = {}): Promise<void> {
  const { size } = await stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}
