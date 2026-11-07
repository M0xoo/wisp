// Events (plan §6.11.2 rule 6): after commit, in order, one queue per plugin, at-least-once with seq,
// capped at 10k with a lagging state and a callback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus, Kernel, type EventEnvelope, type PluginContext, type PluginId } from '../src/index.ts';
import { def, manifest, sleep } from './helpers.ts';

const P = (s: string) => s as PluginId;

test('each plugin gets events in order; a slow one only delays itself', async () => {
  const bus = new EventBus();
  const fast: number[] = [];
  const slow: number[] = [];
  bus.on(P('a.fast'), 'turn.*', (e) => void fast.push((e.data as { i: number }).i));
  bus.on(P('a.slow'), 'turn.finished', async (e) => {
    await sleep(5);
    slow.push((e.data as { i: number }).i);
  });
  for (let i = 0; i < 5; i++) bus.publish(P('wisp.runtime'), 'turn.finished', { i });
  bus.publish(P('wisp.runtime'), 'other.thing', {});
  await sleep(2);
  assert.deepEqual(fast, [0, 1, 2, 3, 4]);
  assert.ok(slow.length < 5);
  assert.equal(bus.busy, true);
  await bus.idle();
  assert.deepEqual(slow, [0, 1, 2, 3, 4]);
  assert.equal(bus.busy, false);
});

test('at-least-once: a handler that throws gets the same envelope again, then it is recorded and skipped', async () => {
  const failures: string[] = [];
  const bus = new EventBus({ attempts: 3, onFailure: (p, type, _e, seq) => failures.push(`${p} ${type} #${seq}`) });
  const seen: number[] = [];
  let flaky = 0;
  bus.on(P('a.flaky'), 'x.y', (e) => {
    seen.push(e.seq);
    if (e.seq === 1 && flaky++ < 1) throw new Error('once');
  });
  bus.on(P('a.broken'), 'x.y', () => {
    throw new Error('always');
  });
  bus.publish(P('a.src'), 'x.y', {});
  bus.publish(P('a.src'), 'x.y', {});
  await bus.idle();
  assert.deepEqual(seen, [1, 1, 2], 'the first one was delivered twice: dedupe by seq');
  assert.deepEqual(failures, ['a.broken x.y #1', 'a.broken x.y #2']);
});

test('past the cap a queue stops growing: the plugin is lagging until it catches up from the feed', async () => {
  const lag: string[] = [];
  const bus = new EventBus({ cap: 3, onLagging: (p, from) => lag.push(`${p} from ${from}`) });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const got: number[] = [];
  bus.on(P('a.stuck'), '*', async (e) => {
    await gate;
    got.push(e.seq);
  });
  for (let i = 0; i < 6; i++) bus.publish(P('a.src'), 'e.x', {});
  assert.deepEqual(lag, ['a.stuck from 4']);
  assert.deepEqual(bus.lagging(P('a.stuck')), { fromSeq: 4 });
  assert.equal(bus.queued(P('a.stuck')), 3);
  release();
  await bus.idle();
  assert.deepEqual(got, [1, 2, 3]);
  bus.publish(P('a.src'), 'e.x', {});
  await bus.idle();
  assert.deepEqual(got, [1, 2, 3, 7], 'it still gets new events: catching up is from the feed');
  bus.caughtUp(P('a.stuck'));
  assert.equal(bus.lagging(P('a.stuck')), undefined);
  bus.caughtUp(P('a.none'));
});

test('dropping a queue (plugin off) stops delivery; an unsubscribed handler is not called', async () => {
  const bus = new EventBus();
  const got: number[] = [];
  const sub = bus.on(P('a.b'), 'x.*', async (e) => {
    await sleep(2);
    got.push(e.seq);
  });
  bus.publish(P('a.src'), 'x.1', {});
  bus.publish(P('a.src'), 'x.2', {});
  sub.dispose();
  bus.drop(P('a.b'));
  bus.drop(P('a.none'));
  await bus.idle();
  assert.ok(got.length <= 1);
  assert.equal(bus.subscriptionsOf(P('a.b')), 0);
});

test('the kernel reports lagging in status and gives events a seq from the store when it has one', async () => {
  let seq = 9000;
  const lagging: string[] = [];
  const k = new Kernel({ events: { cap: 1, nextSeq: () => ++seq, onLagging: (p) => lagging.push(p) } });
  let src: PluginContext | undefined;
  let hold: () => void = () => undefined;
  const gate = new Promise<void>((r) => (hold = r));
  const seen: EventEnvelope[] = [];
  k.register(manifest('wisp.src'), { def: def('wisp.src', (ctx) => void (src = ctx)) });
  k.register(manifest('wisp.slow'), { def: def('wisp.slow', (ctx) => ctx.on('src.*', async (e) => (await gate, void seen.push(e)))) });
  await k.start();
  src?.emit('src.a', 1);
  src?.emit('src.b', 2);
  src?.emit('src.c', 3);
  assert.deepEqual(lagging, ['wisp.slow']);
  assert.equal(k.status().find((s) => s.id === 'wisp.slow')?.lagging, true);
  hold();
  await k.idle();
  assert.equal(seen[0]?.seq, 9001);
  assert.equal(seen[0]?.type, 'src.a');
});

test('event handlers run outside the emitting call: a command they run is a new root', async () => {
  const k = new Kernel();
  const depths: number[] = [];
  k.register(manifest('wisp.a', { contributes: { commands: [{ id: 'a.go', title: 'go' }, { id: 'a.after', title: 'after' }] } }), {
    def: def('wisp.a', (ctx) => {
      ctx.command({ id: 'a.go', run: () => void ctx.emit('a.went', {}) });
      ctx.command({ id: 'a.after', run: (_x, call) => void depths.push(call.trace.depth) });
      ctx.on('a.went', () => ctx.run('a.after').then(() => undefined));
    }),
  });
  await k.start();
  await k.run('a.go', {}, { set: 'user:full' });
  await k.idle();
  assert.deepEqual(depths, [0]);
});
