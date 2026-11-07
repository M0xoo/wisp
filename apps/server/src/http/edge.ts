// One request through the edge (v1 server/index.js's request handler), in order:
//   1. a preview's request (via the trusted proxy, x-wisp-preview) goes to that port on the loopback;
//   2. only same-origin local pages may talk to wisp (agents run with broad permissions), or a trusted
//      proxy that checked who is asking; an open route (a trigger's secret URL) checks itself;
//   3. a non-GET must be JSON (uploads: octet-stream) and, if it sends an Origin, a local one;
//   4. outside /api: the web app; under /api: the route, the caller's set, the route's permission;
//   5. the answer, or the error as { error } (what v1 clients read) plus { code, message, retry }.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRequestContext, HttpResult } from '@wisp/kernel';
import { resolveCaller, type AuthOptions, type Caller } from '../auth.ts';
import { HttpError, answering, readJson, readRaw, send } from './respond.ts';
import { previewPort, previewRequest } from './preview.ts';
import type { Routes } from './router.ts';
import { isShare, shareNoWorker } from './share.ts';
import type { StaticFiles } from './static.ts';
import type { TrustedProxy } from './trust.ts';

const STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  vetoed: 409,
  depth_exceeded: 508,
  reentrant_hook: 508,
  unavailable: 503,
  plugin_off: 503,
  service_gone: 503,
  timeout: 504,
  internal: 500,
};

export interface EdgeOptions {
  port: () => number;
  routes: Routes;
  static: StaticFiles | null;
  proxy: TrustedProxy;
  auth: Omit<AuthOptions, 'viaProxy'>;
  /** is this caller's set allowed this permission? the reason when not */
  check(caller: Caller, permission: string): string | undefined;
  /** routes callable from outside (server.open): no Host/Origin/JSON check */
  open(method: string, pathname: string): boolean;
  /** a non-GET that counts as use (not a channel's inbound message) */
  touched(method: string, pathname: string): void;
  previews: boolean;
  onError(err: unknown, route: string): void;
}

const isUpload = (url: string, ct: string): boolean => (url.startsWith('/api/uploads') || url.startsWith('/api/stuff/upload')) && ct.startsWith('application/octet-stream');

/** A guard's refusal, or undefined to go on. */
function refuse(req: IncomingMessage, o: EdgeOptions, viaProxy: boolean, open: boolean): string | undefined {
  const port = o.port();
  const local = (h: string | undefined): boolean => h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  if (!open && !viaProxy && !local(req.headers.host)) return 'forbidden host';
  if (open || req.method === 'GET' || req.method === 'HEAD') return undefined;
  const origin = req.headers.origin;
  if (viaProxy ? !o.proxy.originOk(req) : origin !== undefined && !local(origin.replace(/^https?:\/\//, ''))) return 'forbidden origin';
  return undefined;
}

export async function handle(req: IncomingMessage, res: ServerResponse, o: EdgeOptions): Promise<void> {
  const viaProxy = o.proxy.via(req);
  if (viaProxy && req.headers['x-wisp-preview'] !== undefined) {
    const p = o.previews ? previewPort(req.headers, o.port()) : 0;
    if (p) previewRequest(req, res, p);
    else send(res, 404, { error: 'not found' });
    return;
  }
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://wisp');
  const pathname = url.pathname;
  const open = o.open(method, pathname);
  const no = refuse(req, o, viaProxy, open);
  if (no) return send(res, 403, { error: no });
  if (isShare(req)) return shareNoWorker(req, res);
  if (!open && method !== 'GET' && method !== 'HEAD') {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.startsWith('application/json') && !isUpload(pathname, ct)) return send(res, 415, { error: 'json only' });
    o.touched(method, pathname);
  }
  if (!pathname.startsWith('/api/') && !o.routes.match(method, pathname)) {
    if (o.static) return o.static.serve(req, res, pathname);
    return send(res, 404, { error: 'not found' });
  }
  await route(req, res, url, viaProxy, o);
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, viaProxy: boolean, o: EdgeOptions): Promise<void> {
  const method = req.method ?? 'GET';
  const m = o.routes.match(method, url.pathname);
  if (!m) return send(res, 404, { error: 'not found' });
  // the body is read at most once: the caller check may need a bySession body, then the handler
  let raw: Promise<Buffer> | undefined;
  let parsed: Promise<unknown> | undefined;
  const rawBody = (): Promise<Buffer> => (raw ??= readRaw(req));
  const body = (): Promise<unknown> =>
    (parsed ??= rawBody().then((b) => {
      if (!b.length) return {};
      try {
        return JSON.parse(b.toString('utf8')) as unknown;
      } catch {
        throw new HttpError(400, 'invalid json');
      }
    }));
  const label = `${method} ${m.route.path}`;
  try {
    const who = await resolveCaller(req, { params: m.params, body }, { ...o.auth, viaProxy });
    if (!who.ok) return send(res, who.status, { error: who.error, code: 'forbidden', message: who.error });
    const why = o.check(who.caller, m.route.opts.permission);
    if (why) return send(res, 403, { error: why, code: 'forbidden', message: why, retry: false });
    const ctx: HttpRequestContext = {
      method,
      path: url.pathname,
      params: m.params,
      query: url.searchParams,
      headers: req.headers,
      caller: who.caller,
      body,
      rawBody: async () => new Uint8Array(await rawBody()),
      raw: { req, res },
    };
    answer(res, await m.route.handler(ctx));
  } catch (err) {
    fault(res, err, label, o);
  }
}

function answer(res: ServerResponse, r: HttpResult | undefined): void {
  if (r === undefined) {
    if (!res.headersSent) res.writeHead(204).end();
    return;
  }
  if ('stream' in r) return;
  const headers = 'headers' in r && r.headers ? r.headers : {};
  if ('json' in r) return send(res, r.status, r.json, headers);
  if ('text' in r) {
    res.writeHead(r.status, { ...headers, 'content-type': r.type ?? 'text/plain; charset=utf-8' });
    res.end(r.text);
    return;
  }
  res.writeHead(r.status, { ...headers, 'content-type': r.type, 'content-length': r.bytes.byteLength });
  res.end(r.bytes);
}

const field = (e: unknown, k: string): unknown => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[k] : undefined);

/** A refusal (bad input, not found, conflict) is an answer, not a server error. */
export function fault(res: ServerResponse, err: unknown, label: string, o: Pick<EdgeOptions, 'onError'>): void {
  const code = field(err, 'code');
  const given = field(err, 'status');
  const status = err instanceof HttpError ? err.status : typeof given === 'number' ? given : typeof code === 'string' ? (STATUS[code] ?? 500) : 500;
  if (status >= 500) o.onError(err, label);
  if (answering.has(res)) return; // the answer is already on its way
  if (res.headersSent) {
    res.end();
    return;
  }
  const message = err instanceof Error ? err.message : String(field(err, 'message') ?? err);
  // v1's extras a client acts on: hold (Ask near the limit), sandboxLogin (/sandbox needs Settings → Cloud)
  const extra = err instanceof HttpError ? err.extra : { ...(field(err, 'hold') !== undefined && { hold: field(err, 'hold') }), ...(field(err, 'sandboxLogin') === true && { sandboxLogin: true }) };
  const retry = field(err, 'retry');
  const wire = { code: typeof code === 'string' ? code : status >= 500 ? 'internal' : 'invalid', message, retry: typeof retry === 'boolean' ? retry : status >= 500 };
  send(res, status, { error: message, ...wire, ...extra });
}

export { readJson };
