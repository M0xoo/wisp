// @wisp/client hot path (plan §8, ADR-0011): a running task streams one token every 16 ms while the
// list shows 5,000 tasks and 3 selectors are live. Each token patches one row. Measured:
//   ms per patch (p50, p99, max), how many row signals fire per patch (must be exactly 1), and how
//   often each selector recomputes.
//   store:  the entity store alone (the writer, as the sync layer calls it)
//   client: the whole path, frame → SyncClient → peer manager → store → signals, via createClient
//   run:    node spikes/client-bench/bench.ts [--rows=5000] [--patches=2000]
//
// The writer is not exported (only the sync layer and the command runner may write), so this spike
// imports it by path. Spikes are not packages; nothing ships from here.

import { performance } from 'node:perf_hooks';
import type { EntityOp, ServerMessage, Topic } from '@wisp/protocol';
import { byKeys, count, createClient, effect, filterBy, peerId, sortBy, type Frame, type Readable, type Transport } from '@wisp/client';
import { createEntityStore } from '../../packages/client/src/entities.ts';
import { entityKey } from '../../packages/client/src/ids.ts';

const arg = (name: string, def: number): number => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const ROWS = arg('rows', 5000);
const PATCHES = arg('patches', 2000);
const PEER = peerId('laptop');

type Session = { id: string; title: string; state: 'running' | 'done' | 'idle'; unread: boolean; updated_at: number; tokens: number; text: string };
const session = (i: number): Session => ({ id: `s${i}`, title: `Fix the flaky upload test ${i}`, state: i % 50 === 0 ? 'running' : i % 3 === 0 ? 'done' : 'idle', unread: i % 7 === 0, updated_at: 1_700_000_000_000 + i, tokens: 0, text: '' });
const rows = Array.from({ length: ROWS }, (_, i) => ({ e: 'session', id: `s${i}`, v: session(i) }));
const HOT = 'laptop:s50'; // a running task
const tokenOp = (n: number): EntityOp => ({ topic: 'list', e: 'session', id: 's50', op: 'patch', ops: [{ op: 'replace', path: '/tokens', value: n }, { op: 'replace', path: '/text', value: `token ${n}` }] });

interface Live {
  fires: Map<string, number>;
  recomputes: { running: number; sorted: number; unread: number };
  stop(): void;
}

/** 3 selectors with effects reading them, and one effect per row signal (a rendered row each). */
function watch(list: Readable<readonly Session[]>, rowOf: (key: string) => Readable<unknown>, keys: readonly string[]): Live {
  const recomputes = { running: 0, sorted: 0, unread: 0 };
  const running = filterBy(list, (s) => s.state === 'running');
  const sorted = sortBy(list, byKeys<Session>({ of: (s) => s.updated_at, desc: true }));
  const unread = count(list, (s) => s.unread);
  const stops = [effect(() => void (running(), recomputes.running++)), effect(() => void (sorted(), recomputes.sorted++)), effect(() => void (unread(), recomputes.unread++))];
  const fires = new Map<string, number>();
  for (const k of keys) {
    const r = rowOf(k);
    let first = true;
    stops.push(
      effect(() => {
        r();
        if (first) first = false;
        else fires.set(k, (fires.get(k) ?? 0) + 1);
      }),
    );
  }
  for (const k of Object.keys(recomputes) as (keyof typeof recomputes)[]) recomputes[k] = 0;
  return { fires, recomputes, stop: () => stops.forEach((s) => s()) };
}

function stats(ms: number[]): string {
  const s = ms.slice().sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return `p50 ${at(0.5).toFixed(3)} ms · p99 ${at(0.99).toFixed(3)} ms · max ${(s.at(-1) ?? 0).toFixed(3)} ms`;
}

function report(name: string, ms: number[], live: Live): boolean {
  const fired = [...live.fires.entries()];
  const onlyHot = fired.length === 1 && fired[0]?.[0] === HOT && fired[0][1] === PATCHES;
  console.log(`${name.padEnd(7)} ${stats(ms)} per patch`);
  console.log(`        row signals fired: ${fired.length} row(s), ${fired.reduce((n, [, c]) => n + c, 0)} times for ${PATCHES} patches → ${onlyHot ? 'exactly 1 row per patch ✓' : 'NOT exactly one ✗'}`);
  console.log(`        selector recomputes: running ${live.recomputes.running}, sorted ${live.recomputes.sorted}, unread ${live.recomputes.unread}`);
  return onlyHot;
}

function benchStore(): boolean {
  const { reader, writer } = createEntityStore();
  writer.snapshot(PEER, 'list', rows);
  const keys = rows.map((r) => entityKey(PEER, r.id));
  const live = watch(reader.list<Session>('session') as Readable<readonly Session[]>, (k) => reader.row('session', k as never), keys);
  const ms: number[] = [];
  for (let n = 1; n <= PATCHES; n++) {
    const t0 = performance.now();
    writer.applyServer(PEER, [tokenOp(n)]);
    ms.push(performance.now() - t0);
  }
  live.stop();
  return report('store', ms, live);
}

/** A transport the bench feeds frame by frame; `next()` resolves when the client took the frame. */
function frameTransport(): Transport & { push(f: Frame): Promise<void> } {
  let take: ((f: Frame) => void) | undefined;
  let taken: (() => void) | undefined;
  return {
    kind: 'bench',
    async *connect() {
      for (;;) {
        const f = await new Promise<Frame>((r) => (take = r));
        yield f;
        taken?.();
      }
    },
    post: async () => {},
    push: (f) =>
      new Promise<void>((r) => {
        taken = r;
        take?.(f);
      }),
  };
}

async function benchClient(): Promise<boolean> {
  const t = frameTransport();
  const client = createClient({ clientId: 'bench', build: 'bench', home: PEER, width: 1280 });
  await client.start([{ peer: PEER, name: 'laptop', transport: t }]);
  client.peers.watch(PEER, 'list' as Topic, client.scope);
  await new Promise((r) => setTimeout(r, 5)); // the peer opens one tick after add()
  const welcome: ServerMessage = { t: 'welcome', epoch: 'e', head_seq: 0, oldest_seq: 0, resume: false, proto: 2, peer: { peer: 'laptop', name: 'laptop', build: 'b', version: '2', proto_min: 2, proto_max: 2, plugins: [] } };
  await t.push({ id: null, messages: [welcome] });
  await t.push({ id: 1, messages: [{ t: 'snapshot', topic: 'list', seq: 1, rows }] });
  const keys = rows.map((r) => entityKey(PEER, r.id));
  const live = watch(client.entities.list<Session>('session') as Readable<readonly Session[]>, (k) => client.entities.row('session', k as never), keys);
  const ms: number[] = [];
  for (let n = 1; n <= PATCHES; n++) {
    const t0 = performance.now();
    await t.push({ id: n + 1, messages: [{ t: 'patch', seq: n + 1, ops: [tokenOp(n)] }] });
    ms.push(performance.now() - t0);
  }
  live.stop();
  client.dispose();
  return report('client', ms, live);
}

console.log(`${ROWS} rows, ${PATCHES} token patches to one row, 3 live selectors, ${ROWS} row effects (budget: 16 ms per frame)`);
const ok = benchStore() && (await benchClient());
process.exit(ok ? 0 : 1);
