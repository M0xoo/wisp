// Test helpers: a fake clock, a seeded PRNG, and a fake transport the test drives frame by frame.

import type { ClientMessage, PeerInfo, ServerMessage, Welcome } from '@wisp/protocol';
import type { Timers } from '../src/clock.ts';
import type { Frame, Transport } from '../src/transport.ts';

export interface FakeTimers extends Timers {
  advance(ms: number): void;
  readonly waiting: number;
}

export function fakeTimers(start = 0): FakeTimers {
  let now = start;
  let n = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++n;
      queue.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      queue.delete(h as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of queue) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get waiting() {
      return queue.size;
    },
  };
}

/** mulberry32: small, fast, and the same sequence for the same seed */
export function prng(seed: number): { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)] as T };
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** An async queue: what the fake server pushes, the transport yields. */
function channel<T>(signal: AbortSignal): { push(v: T): void; end(err?: Error): void; iter: AsyncIterable<T> } {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  signal.addEventListener('abort', () => {
    done = true;
    wake?.();
  });
  return {
    push(v) {
      items.push(v);
      wake?.();
    },
    end(err) {
      done = true;
      failure = err;
      wake?.();
    },
    iter: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (items.length > 0) {
            yield items.shift() as T;
            continue;
          }
          if (done) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      },
    },
  };
}

export interface FakeConnection {
  readonly params: Readonly<Record<string, string>>;
  push(...messages: ServerMessage[]): void;
  frame(id: number | null, ...messages: ServerMessage[]): void;
  end(err?: Error): void;
  readonly aborted: boolean;
}

export interface FakeTransport extends Transport {
  readonly connections: FakeConnection[];
  readonly posted: ClientMessage[];
  /** the next connect throws this instead of opening */
  failNext?: Error;
  wakes: number;
}

export function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    kind: 'fake',
    connections: [],
    posted: [],
    wakes: 0,
    connect(params, signal) {
      if (t.failNext) {
        const err = t.failNext;
        delete t.failNext;
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
        };
      }
      const ch = channel<Frame>(signal);
      t.connections.push({
        params,
        push: (...messages) => ch.push({ id: null, messages }),
        frame: (id, ...messages) => ch.push({ id, messages }),
        end: (err) => ch.end(err),
        get aborted() {
          return signal.aborted;
        },
      });
      return ch.iter;
    },
    async post(message) {
      t.posted.push(message);
    },
    async wake() {
      t.wakes += 1;
    },
  };
  return t;
}

export function peerInfo(over: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peer: 'laptop',
    name: 'laptop',
    build: 'test',
    version: '2.0.0',
    proto_min: 2,
    proto_max: 2,
    plugins: [{ id: 'wisp.runtime', version: '2.0.0', commands: ['session.rename'], topics: ['list'], blocks: [] }],
    ...over,
  };
}

export function welcome(over: Partial<Welcome> = {}, info: Partial<PeerInfo> = {}): Welcome {
  return { t: 'welcome', epoch: 'e1', head_seq: 0, oldest_seq: 0, resume: false, proto: 2, peer: peerInfo(info), ...over };
}
