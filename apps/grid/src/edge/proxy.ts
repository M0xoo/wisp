// Requests on their way into a box: the edge's proxy (HTTP + SSE), with the box's trusted-proxy
// secret. Its headers: what came from outside minus the grid's marks and sign-in (trust.ts
// fromOutside), then the grid's own marks. The inbox's delivery is inbox-drain.ts boxDelivery.

import http from 'node:http';
import type { BoxUser } from '../rows.ts';
import { clientIp, json, type Req, type Res } from '../http.ts';
import { fromOutside, isHop, viaHeader } from '../trust.ts';
import type { Ctx } from './context.ts';
import { msg } from './util.ts';

/** Response headers to send on: everything but hop-by-hop ones. */
export function answerHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !isHop(k)) out[k] = v;
  return out;
}

// via: how the grid signed them in. Only 'key' is passed on, for what wisp won't do for a key
// (API keys can't manage keys); x-wisp-proxy-* from outside is dropped, so it can't be claimed.
export function proxy(x: Ctx, req: Req, res: Res, port: number, box: BoxUser, secret: string, via: string): void {
  // A request on its way keeps its wisp up; a page's event stream doesn't (it stays open for
  // hours): wisp counts open pages itself, and leaves out a desktop relaying them (/api/status).
  if (!String(req.url).startsWith('/api/events')) res.on('close', x.hostd.begin(box.id));
  const headers = {
    ...fromOutside(req.headers),
    'x-wisp-proxy-secret': secret,
    'x-forwarded-host': String(req.headers.host ?? ''),
    'x-forwarded-proto': x.cfg.scheme,
    'x-forwarded-for': clientIp(req),
    ...(via === 'key' && viaHeader('key', 'edge')),
  };
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, answerHeaders(r.headers));
    r.pipe(res);
    r.on('end', () => x.hostd.touch(box.id));
    // Its wisp went away mid-stream (stopped): end the page's stream too, so it notices.
    r.on('close', () => {
      if (!res.writableEnded) res.destroy();
    });
  });
  up.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: `Its wisp didn’t answer: ${msg(err)}` });
    else res.destroy();
  });
  // The page went away (an SSE stream closed): let the wisp see it, so it can go idle.
  res.on('close', () => up.destroy());
  req.pipe(up);
}
