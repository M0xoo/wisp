// The mock peer through the real client (@wisp/client + @wisp/sync), so screens built against it
// behave as they will against the Rust wisp: snapshots on hello, a command's patch and ack, a refused
// command's rollback and toast, a streaming turn, a dropped stream.
import { expect, test } from 'vitest';
import { createClient, peerId, type EntityKey, type Frame, type Transport } from '@wisp/client';
import type { ClientMessage } from '@wisp/protocol';
import { createMockPeer, type MockPeer, type MockTimers } from '../dev/mock-peer.ts';

function fakeTimers(): MockTimers & { run(ms: number): void } {
  let now = 1_800_000_000_000;
  const q: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => q.push({ at: now + ms, fn }),
    clearTimeout: () => {},
    run(ms) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

/** A transport that talks to the mock in memory, frame by frame, like the HTTP one does. */
function memTransport(peer: MockPeer): Transport & { drop(): void } {
  let clientId = '';
  let end: (() => void) | undefined;
  return {
    kind: 'mem',
    async *connect(params, signal): AsyncGenerator<Frame> {
      const frames: Frame[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const conn = peer.connect(params, (f) => {
        frames.push(f);
        wake?.();
      });
      clientId = conn.clientId;
      end = () => {
        closed = true;
        conn.close();
        wake?.();
      };
      signal.addEventListener('abort', () => end?.());
      while (!closed) {
        const f = frames.shift();
        if (f) yield f;
        else await new Promise<void>((r) => (wake = r));
      }
    },
    async post(m: ClientMessage) {
      peer.receive(clientId, m);
    },
    drop: () => end?.(),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup() {
  const timers = fakeTimers();
  const mock = createMockPeer({ timers, epoch: 'e1' });
  const errors: string[] = [];
  const client = createClient({ clientId: 'c1', build: 't', home: peerId('local'), width: 1440, onError: (e) => errors.push(e.message) });
  const tr = memTransport(mock);
  await client.start([{ peer: peerId('local'), name: 'mock', transport: tr }]);
  const scope = client.scope.child('test');
  client.peers.watch(peerId('local'), 'list', scope);
  client.peers.watch(peerId('local'), 'config', scope);
  await settle();
  return { client, mock, timers, errors, tr };
}

const rename = (key: EntityKey) => ({ id: 'runtime.rename', owner: () => peerId('local'), optimistic: () => [{ e: 'session', id: key, op: 'patch' as const, ops: [{ op: 'replace' as const, path: '/title', value: 'Renamed' }] }] });
const title = (c: ReturnType<typeof createClient>, key: EntityKey): string => (c.entities.peek('session', key) as { title: string }).title;

test('the hello brings the list, and the peer says what it offers', async () => {
  const { client } = await setup();
  expect(client.entities.list('session')().length).toBe(10);
  expect(client.peers.status(peerId('local'))().kind).toBe('online');
  expect(client.peers.hasFeature(peerId('local'), { plugin: 'wisp.runtime', command: 'runtime.rename' }).ok).toBe(true);
});

test('a command patches and acks; a refusal rolls back and says why', async () => {
  const { client, mock, errors } = await setup();
  const key = 'local:s0001' as EntityKey;
  await client.commands.run(rename(key) as never, { id: key, title: 'Renamed' } as never);
  await settle();
  expect(title(client, key)).toBe('Renamed');
  mock.failNext('runtime.rename', 'Not now');
  const r2 = { ...rename(key), optimistic: () => [{ e: 'session', id: key, op: 'patch' as const, ops: [{ op: 'replace' as const, path: '/title', value: 'Nope' }] }] };
  const p = client.commands.run(r2 as never, { id: key, title: 'Nope' } as never).catch(() => 'refused');
  expect(title(client, key)).toBe('Nope'); // on screen at once
  expect(await p).toBe('refused');
  await settle();
  expect(title(client, key)).toBe('Renamed');
  expect(errors).toEqual(['Not now']);
});

test('a streaming turn grows its text event and moves the list row along', async () => {
  const { client, mock, timers } = await setup();
  const key = 'local:s0000' as EntityKey;
  const tr = client.transcripts.open<{ kind: string; body: { text?: string } }>(peerId('local'), key, client.scope.child('t'));
  await settle();
  const before = tr.events().length;
  expect(before).toBe(4);
  mock.stream(key, { tokens: 30, everyMs: 16 });
  timers.run(16 * 10);
  await settle();
  const mid = tr.events().at(-1)?.body.text ?? '';
  timers.run(16 * 40);
  await settle();
  const last = tr.events().at(-1)?.body.text ?? '';
  expect(tr.events().length).toBe(before + 2);
  expect(last.length).toBeGreaterThan(mid.length);
  expect((client.entities.peek('session', key) as { state: string }).state).toBe('review');
});

test('an unknown command is refused with a pointer to where to add it', async () => {
  const { client, errors } = await setup();
  await client.commands.run({ id: 'nope.do', owner: () => peerId('local'), optimistic: 'none' } as never, {} as never).catch(() => {});
  await settle();
  expect(errors[0]).toMatch(/mock-commands\.ts/);
});

test('a dropped stream shows the peer offline', async () => {
  const { client, tr } = await setup();
  tr.drop();
  await settle();
  expect(client.peers.status(peerId('local'))().kind).not.toBe('online');
});
