// The HTTP transport (plan §4.3): GET /api/events streams the frames, POST /api/events carries
// sub/unsub/window/mutate for that stream (X-Wisp-Client names it). EventSource-free: fetch with a
// streamed body and @wisp/sync's SSE parser, so headers (a device token) and the abort signal work
// everywhere. This is the only `fetch` in the UI (plan §4.6.8).

import type { ClientMessage } from '@wisp/protocol';
import { SseParser, decodeFrame } from '@wisp/sync';
import { PeerDown, type Frame, type Transport } from './transport.ts';

/** The part of a fetch Response the transport reads; the global `fetch` fits it. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  /** a ReadableStream of bytes; typed loosely because getReader's DOM overloads don't fit a structural type */
  readonly body: object | null;
  text(): Promise<string>;
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

function readerOf(body: object | null): ByteReader | undefined {
  const b = body as { getReader?: unknown } | null;
  return b && typeof b.getReader === 'function' ? (b.getReader as () => ByteReader).call(b) : undefined;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Blob | ArrayBuffer; signal: AbortSignal }) => Promise<FetchResponse>;

export interface HttpTransportOptions {
  /** the peer's origin: 'https://box.grid.trywisp.dev' or '' for the page's own wisp */
  base: string;
  fetch?: FetchLike;
  /** per request, so a refreshed device token is picked up */
  headers?: () => Record<string, string>;
  /** statuses that mean a sleeping box rather than a failure (the grid answers 503 + this header) */
  asleep?: (status: number, body: string) => boolean;
}

export function httpTransport(o: HttpTransportOptions): Transport {
  const fetchFn: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let clientId = '';

  const failure = async (res: FetchResponse, what: string): Promise<PeerDown> => {
    const text = await res.text().catch(() => '');
    if (o.asleep?.(res.status, text)) return new PeerDown('asleep', 'asleep');
    return new PeerDown('unreachable', `${what}: HTTP ${res.status}`);
  };

  return {
    kind: 'http',
    async *connect(params, signal): AsyncGenerator<Frame> {
      clientId = params['client_id'] ?? clientId;
      const q = new URLSearchParams(params).toString();
      const res = await fetchFn(`${o.base}/api/events?${q}`, { method: 'GET', headers: { accept: 'text/event-stream', ...o.headers?.() }, signal });
      const reader = res.ok ? readerOf(res.body) : undefined;
      if (!reader) throw await failure(res, 'events');
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || signal.aborted) return;
          if (!value) continue;
          for (const ev of parser.push(value)) {
            const frame = decodeFrame(ev);
            if (frame) yield frame;
          }
        }
      } finally {
        reader.cancel().catch(() => {}); // frees the connection when the consumer stops early
      }
    },
    async post(message: ClientMessage, signal) {
      const res = await fetchFn(`${o.base}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wisp-client': clientId, ...o.headers?.() },
        body: JSON.stringify(message),
        signal,
      });
      if (!res.ok) throw await failure(res, message.t);
    },
    async request(r, signal) {
      const res = await fetchFn(`${o.base}/api${r.path}`, {
        method: r.method,
        headers: { ...(r.contentType && { 'content-type': r.contentType }), ...o.headers?.() },
        ...(r.body !== undefined && { body: r.body }),
        signal,
      });
      return { status: res.status, text: await res.text() };
    },
    async *events(path, signal) {
      const res = await fetchFn(`${o.base}/api${path}`, { method: 'GET', headers: { accept: 'text/event-stream', ...o.headers?.() }, signal });
      const reader = res.ok ? readerOf(res.body) : undefined;
      if (!reader) throw await failure(res, path);
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || signal.aborted) return;
          if (value) for (const ev of parser.push(value)) yield { event: ev.event, data: ev.data };
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },
  };
}
