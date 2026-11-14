// A saved computer as a @wisp/client Transport (plan §7.2.2, §7.3.1). Every connect asks the native
// side how to reach it first: an SSH tunnel may have come back on another local port, a grid's
// device token may have been renewed. Then it is plain HTTP sync (httpTransport): SSE over fetch
// on GET /api/events, POSTs for sub/unsub/window/mutate, with `Authorization: Bearer <token>`.

import type { ClientMessage } from '@wisp/protocol';
import { httpTransport, PeerDown, type FetchLike, type Frame, type Transport } from '@wisp/client';
import type { Computer, NativeBridge, Reached } from './bridge.ts';

export interface BridgeTransportOptions {
  /** the WebView's fetch by default */
  fetch?: FetchLike;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The token is the computer's own (server.json over SSH) or the grid's device token. */
const auth = (token: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/**
 * A grid that put a box to sleep answers 503 with `{"asleep": true}` and doesn't start it for a
 * passive request. A 503 `{"waking": true}` is a box on its way up: retried, not asleep.
 */
export function gridAsleep(status: number, body: string): boolean {
  if (status !== 503) return false;
  try {
    const o: unknown = JSON.parse(body);
    return typeof o === 'object' && o !== null && (o as { asleep?: unknown }).asleep === true;
  } catch {
    return false;
  }
}

function httpFor(r: Reached, fetchFn: FetchLike | undefined): Transport {
  const base = r.kind === 'ssh' ? `http://127.0.0.1:${r.port}` : r.base;
  return httpTransport({ base, headers: () => auth(r.token), ...(fetchFn && { fetch: fetchFn }), ...(r.kind === 'grid' && { asleep: gridAsleep }) });
}

export function bridgeTransport(bridge: NativeBridge, computer: Pick<Computer, 'id' | 'kind'>, o: BridgeTransportOptions = {}): Transport {
  let open: Transport | undefined; // the connection's own: posts go where its stream went

  const reach = async (): Promise<Reached> => {
    try {
      return await bridge.connect(computer.id);
    } catch (err) {
      throw new PeerDown('unreachable', message(err));
    }
  };

  const transport: Transport = {
    kind: computer.kind,
    async *connect(params, signal): AsyncGenerator<Frame> {
      const r = await reach();
      if (signal.aborted) return;
      const http = httpFor(r, o.fetch);
      open = http;
      yield* http.connect(params, signal);
    },
    post(m: ClientMessage, signal) {
      return open ? open.post(m, signal) : Promise.reject(new PeerDown('unreachable', 'not connected'));
    },
  };
  if (computer.kind !== 'grid') return transport;
  return { ...transport, wake: (signal) => wakeGrid(reach, o.fetch, signal) };
}

/**
 * The grid starts a box on any request that isn't passive (v1 grid/server.js boxEdge): one GET of
 * its /api/health does it. A 503 means it's still starting, which the next connect rides out.
 */
async function wakeGrid(reach: () => Promise<Reached>, fetchFn: FetchLike | undefined, signal: AbortSignal): Promise<void> {
  const r = await reach();
  if (r.kind !== 'grid') return;
  const f: FetchLike = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const res = await f(`${r.base}/api/health`, { method: 'GET', headers: { accept: 'application/json', ...auth(r.token) }, signal });
  if (res.status === 401 || res.status === 403) throw new Error(`Signed out of ${r.name}: sign in to the grid again`);
}
