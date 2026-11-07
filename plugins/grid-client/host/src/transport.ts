// The `grid` and `grid-tunnel` transports (machines.transport@1), v1 machines.js #connectGrid, #asleep,
// #online and #gridEdge. A cloud computer or a sandbox (`grid`) is reached at its own https address
// with its device token; an asleep one is woken by the next request. Another of your computers
// (`grid-tunnel`) is reached the same way, through the tunnel it holds to the grid; when it isn't
// connected nothing here can wake it, so it is followed until it comes back.

import { PeerHttpError, TransportError } from '@wisp-plugin/machines-api';
import type { AddArgs, Channel, ChannelEnd, ChannelRequest, ChannelResponse, ConnectIO, PeerRow, Transport } from '@wisp-plugin/machines-api';
import type { Scope } from '@wisp/kernel';
import { gridJson, str, target, why } from './grid-http.ts';

const STEPS = [['wake', 'Wake it up'], ['agents', 'Find harnesses']] as const;
const WAKE_MS = 90_000;
const TRY_MS = 30_000;
const PAUSE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface TransportHooks {
  scope: Scope;
  now(): number;
  /** v1 computer.removing: tidy up on the grid, and the peers that go with this one */
  forget(peer: PeerRow, all: readonly PeerRow[]): Promise<{ also?: string[] }>;
}

/** Waits `ms` on the plugin's scope; an abort ends the wait early. */
export function pause(scope: Scope, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    scope.timeout(ms, resolve);
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function* chunks(body: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const c of body) yield c;
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const out: Buffer[] = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out).toString('utf8');
}

/** One request to the peer's wisp at `${origin}/api${path}`; resolves once the answer's head is in. */
export function send(origin: string, token: string, req: ChannelRequest): Promise<ChannelResponse> {
  const { lib, opts } = target(origin);
  const headers: Record<string, string> = { ...req.headers, authorization: `Bearer ${token}` };
  // a passive request (the event stream, a watch) never counts as use, so it never keeps a box up
  if (req.passive) headers['x-wisp-relay'] = '1';
  const body = req.body;
  if (typeof body === 'string' || body instanceof Uint8Array) headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
  return new Promise((resolve, reject) => {
    const r = lib.request({ ...opts, method: req.method, path: `/api${req.path}`, headers, timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS }, (res) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
      resolve({ status: res.statusCode ?? 502, headers: out, body: chunks(res), text: () => readAll(res), cancel: () => (res.destroy(), r.destroy()) });
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error(`${new URL(origin).host} didn’t answer in time.`), { status: 504 })));
    r.on('error', (err: Error & { status?: number }) => reject(Object.assign(err, { status: err.status ?? 502 })));
    if (req.signal?.aborted) return void r.destroy(new Error('aborted'));
    req.signal?.addEventListener('abort', () => r.destroy(new Error('aborted')), { once: true });
    if (body === undefined || typeof body === 'string' || body instanceof Uint8Array) r.end(body);
    else void pump(body, r);
  });
}

async function pump(body: AsyncIterable<Uint8Array>, r: import('node:http').ClientRequest): Promise<void> {
  try {
    for await (const c of body) if (!r.write(c)) await new Promise((res) => r.once('drain', res));
    r.end();
  } catch (err) {
    r.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}

/** A way to the peer: each request one HTTPS request with the token; close() ends it. */
function channel(peer: PeerRow, token: () => Promise<string | undefined>): Channel {
  let end: (e: ChannelEnd) => void = () => {};
  const closed = new Promise<ChannelEnd>((r) => (end = r));
  return {
    label: new URL(peer.address).host,
    closed,
    close: () => end({ reason: 'closed' }),
    request: async (req) => {
      const t = await token();
      if (!t) throw new PeerHttpError(`Signed out of ${peer.name}: Settings → Cloud → Sign in again.`, 409);
      return send(peer.address, t, req);
    },
  };
}

const signedOut = (): TransportError =>
  new TransportError({ message: 'Signed out of this cloud computer.', hint: { title: 'Sign in again', text: 'Settings → Cloud → Sign in, with the same grid.' }, giveUp: true });
const refused = (): TransportError =>
  new TransportError({ message: 'The grid didn’t accept this computer’s sign-in.', hint: { title: 'Signed out', text: 'The device was revoked or expired. Settings → Cloud → Sign in again.' }, giveUp: true, status: 401 });

/** Asks /health until it answers (a box starting takes a while), up to 90 s. */
async function wake(h: TransportHooks, peer: PeerRow, io: ConnectIO, token: string, signal: AbortSignal): Promise<void> {
  const until = h.now() + WAKE_MS;
  while (h.now() < until) {
    signal.throwIfAborted();
    let detail: string;
    try {
      const r = await send(peer.address, token, { method: 'GET', path: '/health', timeoutMs: TRY_MS, signal });
      if (r.status < 400) return void r.cancel();
      const text = await r.text().catch(() => '');
      // your other computer isn't connected to the grid: nothing here can wake it
      if (r.status === 503 && peer.transport === 'grid-tunnel') throw new TransportError({ message: `${peer.name} is offline.`, kind: 'asleep' });
      if (r.status === 401 || r.status === 403) throw refused();
      detail = r.status === 503 ? 'Starting…' : errorOf(text) || `The grid said ${r.status}.`;
    } catch (err) {
      if (err instanceof TransportError) throw err;
      signal.throwIfAborted();
      detail = why(err);
    }
    io.step('wake', 'run', detail);
    await pause(h.scope, PAUSE_MS, signal);
  }
  throw new TransportError({ message: 'It didn’t wake up in time.' });
}

const errorOf = (text: string): string => {
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === 'object' ? str((j as Record<string, unknown>)['error']) : '';
  } catch {
    return '';
  }
};

/** A request to the grid's edge itself (/_grid/…), which never wakes the computer. */
async function edge(peer: PeerRow, token: string | undefined, method: string, p: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return gridJson(`${peer.address}${p}`, { method, ...(token !== undefined && { token }), ...(method !== 'GET' && { body: {} }) });
}

/** A grid peer's address comes from the grid: only its name and auto-connect change here (v1 #clean). */
function clean(input: AddArgs, prev: PeerRow | undefined): Partial<PeerRow> {
  const name = String(input.name ?? '').trim().slice(0, 40);
  const autoConnect = (input.autoConnect ?? prev?.autoConnect ?? true) !== false;
  if (prev) return { name: name || prev.name, autoConnect };
  const u = new URL(String(input.address ?? input.target ?? ''));
  return { name: name || u.hostname.slice(0, 40), address: u.origin, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), command: '', autoConnect };
}

function make(kind: 'grid' | 'grid-tunnel', h: TransportHooks): Transport {
  return {
    kind,
    steps: STEPS,
    clean,
    async connect(peer, io, signal) {
      const token = await io.secret();
      if (!token) throw signedOut();
      await wake(h, peer, io, token, signal);
      io.step('wake', 'done', new URL(peer.address).host);
      return channel(peer, async () => token);
    },
    async probe(peer, io) {
      const r = await edge(peer, await io.secret(), 'GET', '/_grid/state').catch(() => null);
      if (r?.status === 401) return 'gone';
      return r?.body['state'] === 'running' ? 'running' : 'asleep';
    },
    wakesOnRequest: () => kind === 'grid',
    direct: (peer, io) => channel(peer, () => io.secret()),
    async stopRemote(peer, io) {
      if (kind === 'grid-tunnel') throw new PeerHttpError(`wisp on ${peer.name} runs on that computer: stop it there.`, 400);
      // the grid stops it, and starts it again on the next request
      const r = await edge(peer, await io.secret(), 'POST', '/_grid/stop');
      if (r.status >= 400) throw new PeerHttpError(str(r.body['error']) || `The grid said ${r.status}.`, r.status);
      return 'asleep';
    },
    forget: (peer, all) => h.forget(peer, all),
    terminalArgv: () => null,
    autoStart: () => false,
  };
}

export const gridTransports = (h: TransportHooks): Transport[] => [make('grid', h), make('grid-tunnel', h)];
