// Fakes for the phone's tests: a clock the test advances, the native bridge, and a fetch that
// streams SSE frames the test pushes (encoded as a real wisp would, with @wisp/sync).

import type { FetchLike, FetchResponse, Timers } from '@wisp/client';
import { PROTO, PROTO_MIN, type PeerInfo, type ServerMessage, type Welcome } from '@wisp/protocol';
import { encodeFrame } from '@wisp/sync';
import type { Computer, ComputerPatch, NativeBridge, Reached, TunnelEvent } from '../src/bridge.ts';

export interface FakeTimers extends Timers {
  advance(ms: number): void;
}

export function fakeTimers(start = 1_700_000_000_000): FakeTimers {
  const clock = { now: start, n: 0 };
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock.now,
    setTimeout(fn, ms) {
      queue.set(++clock.n, { at: clock.now + Math.max(0, ms), fn });
      return clock.n;
    },
    clearTimeout: (h) => void queue.delete(h as number),
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const next = [...queue].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        queue.delete(next[0]);
        clock.now = next[1].at;
        next[1].fn();
      }
      clock.now = end;
    },
  };
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** lets streams deliver and zero-delay timers run */
export async function settle(clock?: FakeTimers): Promise<void> {
  for (let i = 0; i < 8; i++) {
    clock?.advance(0);
    await tick();
  }
}

type Listener<T> = Set<(v: T) => void>;

export interface FakeBridge extends NativeBridge {
  computers: Computer[];
  /** what the next connects answer, in order; the last one repeats */
  answers: (Reached | Error)[];
  readonly connects: string[];
  readonly saves: (Computer | ComputerPatch)[];
  leaves: number;
  emit: { computers(): void; tunnel(e: TunnelEvent): void; back(): void; open(t: unknown): void };
}

export function fakeBridge(computers: Computer[] = []): FakeBridge {
  const on = { computers: new Set() as Listener<void>, tunnel: new Set() as Listener<TunnelEvent>, back: new Set() as Listener<void>, open: new Set() as Listener<unknown> };
  const add = <T>(set: Listener<T>, fn: (v: T) => void): (() => void) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const b: FakeBridge = {
    computers,
    answers: [],
    connects: [],
    saves: [],
    leaves: 0,
    list: async () => [...b.computers],
    async save(c) {
      b.saves.push(c);
      const i = b.computers.findIndex((x) => x.id === c.id);
      if (i >= 0) b.computers[i] = { ...b.computers[i], ...c } as Computer;
      else b.computers.push(c as Computer);
      for (const fn of on.computers) fn();
    },
    async forget(id) {
      b.computers = b.computers.filter((c) => c.id !== id);
      for (const fn of on.computers) fn();
    },
    async connect(id) {
      b.connects.push(id);
      const a = b.answers.length > 1 ? b.answers.shift() : b.answers[0];
      if (!a) throw new Error('no answer set');
      if (a instanceof Error) throw a;
      return a;
    },
    disconnect: async () => {},
    leave: async () => void (b.leaves += 1),
    onTunnel: (fn) => add(on.tunnel, fn),
    onComputers: (fn) => add(on.computers, () => fn()),
    onBack: (fn) => add(on.back, () => fn()),
    onOpen: (fn) => add(on.open, fn),
    emit: {
      computers: () => on.computers.forEach((fn) => fn()),
      tunnel: (e) => on.tunnel.forEach((fn) => fn(e)),
      back: () => on.back.forEach((fn) => fn()),
      open: (t) => on.open.forEach((fn) => fn(t)),
    },
  };
  return b;
}

export interface Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** One open GET /api/events: the test pushes frames into it. */
export interface Stream {
  readonly request: Request;
  frame(id: number | null, ...messages: ServerMessage[]): void;
  end(): void;
}

export interface FakeServer {
  readonly fetch: FetchLike;
  readonly requests: Request[];
  readonly streams: Stream[];
  /** the answer to anything that isn't the stream: 200 '{}' by default */
  reply?: (r: Request) => { status: number; body: string } | undefined;
}

const text = (status: number, body: string): FetchResponse => ({ ok: status < 400, status, body: null, text: async () => body });

function stream(request: Request, signal: AbortSignal): { s: Stream; res: FetchResponse } {
  const chunks: Uint8Array[] = [];
  const st = { done: false, wake: undefined as (() => void) | undefined };
  const poke = (): void => st.wake?.();
  signal.addEventListener('abort', () => {
    st.done = true;
    poke();
  });
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      while (chunks.length === 0 && !st.done) await new Promise<void>((r) => (st.wake = r));
      const value = chunks.shift();
      return value ? { done: false, value } : { done: true };
    },
    cancel: async () => void (st.done = true),
  };
  const s: Stream = {
    request,
    frame: (id, ...messages) => {
      chunks.push(new TextEncoder().encode(encodeFrame(id, messages)));
      poke();
    },
    end: () => {
      st.done = true;
      poke();
    },
  };
  return { s, res: { ok: true, status: 200, body: { getReader: () => reader }, text: async () => '' } };
}

export function fakeServer(): FakeServer {
  const srv: FakeServer = {
    requests: [],
    streams: [],
    fetch: async (url, init) => {
      const r: Request = { url, method: init.method, headers: init.headers, ...(init.body !== undefined && { body: init.body }) };
      srv.requests.push(r);
      const custom = srv.reply?.(r);
      if (custom) return text(custom.status, custom.body);
      if (r.method === 'GET' && url.includes('/api/events?')) {
        const { s, res } = stream(r, init.signal);
        srv.streams.push(s);
        return res;
      }
      return text(200, '{}');
    },
  };
  return srv;
}

export function welcome(peer = 'studio-1f3a', over: Partial<PeerInfo> = {}): Welcome {
  const info: PeerInfo = { peer, name: 'Studio', build: 'test', version: '2.0.0', proto_min: PROTO_MIN, proto_max: PROTO, plugins: [], ...over };
  return { t: 'welcome', epoch: 'e1', head_seq: 0, oldest_seq: 0, resume: false, proto: PROTO, peer: info };
}

export const ssh = (id: string, over: Partial<Computer> = {}): Computer => ({ id, kind: 'ssh', name: id, target: `me@${id}`, ...over }) as Computer;
export const grid = (id: string, over: Partial<Computer> = {}): Computer => ({ id, kind: 'grid', name: id, url: `https://${id}.grid.test`, token: 'dev-token', ...over }) as Computer;
