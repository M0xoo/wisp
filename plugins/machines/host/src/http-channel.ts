// Requests to a peer's wisp on a forwarded loopback port (the ssh transport's channel). node:http as
// a client, not the net service's fetch: the far wisp only answers its own `Host: 127.0.0.1:<port>`
// (its DNS-rebinding guard), and fetch drops a Host header. No server is opened here.

import http from 'node:http';
import type { Channel, ChannelEnd, ChannelRequest, ChannelResponse } from '@wisp-plugin/machines-api';

export interface LoopbackOptions {
  port: number;
  /** the Host header the far side insists on */
  host: string;
  label: string;
  closed: Promise<ChannelEnd>;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function loopbackChannel(o: LoopbackOptions): Channel {
  return {
    label: o.label,
    closed: o.closed,
    close: o.close,
    request: (req) => send({ host: '127.0.0.1', port: o.port, headers: { host: o.host } }, req),
  };
}

export interface Target {
  host: string;
  port: number;
  headers: Record<string, string>;
  /** an https agent or a lookup override, for transports that need them */
  lib?: typeof http;
  extra?: http.RequestOptions;
}

/** One request; resolves when the answer's head has come, with its body still streaming. */
export function send(t: Target, req: ChannelRequest): Promise<ChannelResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...req.headers, ...t.headers };
    const body = req.body;
    if (typeof body === 'string' || body instanceof Uint8Array) headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    const r = (t.lib ?? http).request({ ...t.extra, host: t.host, port: t.port, method: req.method, path: `/api${req.path}`, headers, timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS }, (res) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
      resolve({
        status: res.statusCode ?? 502,
        headers: out,
        body: res,
        text: () => readAll(res),
        cancel: () => {
          res.destroy();
          r.destroy();
        },
      });
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    r.on('error', reject);
    const abort = (): void => {
      r.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    };
    if (req.signal?.aborted) return abort();
    req.signal?.addEventListener('abort', abort, { once: true });
    r.on('close', () => req.signal?.removeEventListener('abort', abort));
    if (body === undefined || typeof body === 'string' || body instanceof Uint8Array) r.end(body);
    else void pump(body, r);
  });
}

async function pump(body: AsyncIterable<Uint8Array>, r: http.ClientRequest): Promise<void> {
  try {
    for await (const chunk of body) if (!r.write(chunk)) await new Promise((res) => r.once('drain', res));
    r.end();
  } catch (err) {
    r.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
