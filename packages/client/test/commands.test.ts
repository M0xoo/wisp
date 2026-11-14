import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mutate } from '@wisp/protocol';
import { CommandError, createCommands, defineCommand } from '../src/commands.ts';
import { createEntityStore } from '../src/entities.ts';
import { entityKey, peerId } from '../src/ids.ts';
import { createPeers } from '../src/peers.ts';
import { memoryPersist, type Persist } from '../src/persist.ts';
import { createScope } from '../src/scope.ts';
import type { EntityKey } from '../src/types.ts';
import { fakeTimers, type FakeTimers, fakeTransport, tick, welcome } from './helpers.ts';

const A = peerId('laptop');
const S1 = entityKey(A, 's1');

const rename = defineCommand<{ id: EntityKey; title: string }>({
  id: 'session.rename',
  owner: (a) => a.id,
  optimistic: (base, a) => {
    const row = base.peek<{ title: string }>('session', a.id);
    return row ? [{ e: 'session', id: a.id, op: 'patch', ops: [{ op: 'replace', path: '/title', value: a.title }] }] : [];
  },
});
const followUp = defineCommand<{ id: EntityKey; text: string }>({ id: 'session.followUp', owner: (a) => a.id, optimistic: 'none', pending: 'the session.followUp control' });

let clockNow: FakeTimers | undefined; // the running test's clock
/** lets streams deliver and zero-delay timers (a peer's first open) run */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    clockNow?.advance(0);
    await tick();
  }
}

async function setup(persist: Persist = memoryPersist(), opts: { connect?: boolean } = {}) {
  const clock = fakeTimers(1_700_000_000_000);
  clockNow = clock;
  const scope = createScope('test', clock);
  const { reader, writer } = createEntityStore();
  const peers = createPeers({ scope, writer, clientId: 'c1', build: 'test' });
  const errors: CommandError[] = [];
  const commands = createCommands({ reader, writer, peers, persist, now: clock.now, onError: (e) => errors.push(e) });
  const t = fakeTransport();
  peers.add({ peer: A, name: 'laptop', transport: t });
  peers.watch(A, 'list', scope);
  await settle();
  const conn = () => {
    const c = t.connections.at(-1);
    assert.ok(c, 'a connection is open');
    return c;
  };
  if (opts.connect !== false) {
    conn().push(welcome());
    await settle();
    conn().frame(1, { t: 'snapshot', topic: 'list', seq: 1, rows: [{ e: 'session', id: 's1', v: { title: 'old' } }] });
    await settle();
    assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'old');
  }
  const mutates = () => t.posted.filter((m): m is Mutate => m.t === 'mutate');
  return { clock, scope, reader, writer, peers, commands, errors, t, conn, mutates, persist };
}

test('a command shows its optimistic patch at once, and the ack keeps it as the server state', async () => {
  const { reader, commands, conn, mutates } = await setup();
  const done = commands.run(rename, { id: S1, title: 'new' });
  assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'new', 'before any answer');
  const [m] = mutates();
  assert.ok(m);
  assert.match(m.mid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'the mid is a UUIDv7');
  assert.equal(m.cmd, 'session.rename');
  conn().frame(7, { t: 'patch', seq: 7, ops: [{ topic: 'list', e: 'session', id: 's1', op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'new' }] }] }, { t: 'ack', mid: m.mid, seq: 7, result: { ok: 1 } });
  await settle();
  assert.deepEqual(await done, { ok: 1 });
  assert.equal(reader.pending()().length, 0);
  assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'new');
});

test('a reject rolls the optimistic patch back and calls onError (the toast)', async () => {
  const { reader, commands, conn, mutates, errors } = await setup();
  const done = commands.run(rename, { id: S1, title: 'bad' });
  assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'bad');
  conn().push({ t: 'reject', mid: mutates()[0]?.mid ?? '', code: 'vetoed', message: 'titles are locked' });
  await settle();
  await assert.rejects(done, (e: unknown) => e instanceof CommandError && e.code === 'vetoed');
  assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'old');
  assert.deepEqual(errors.map((e) => e.message), ['titles are locked']);
});

test('a command can not run twice: the same run while in flight is the first run (#643)', async () => {
  const { commands, mutates, conn } = await setup();
  const a = commands.run(followUp, { id: S1, text: 'go' });
  const b = commands.run(followUp, { id: S1, text: 'go' });
  assert.equal(a, b);
  assert.equal(mutates().length, 1);
  conn().push({ t: 'ack', mid: mutates()[0]?.mid ?? '', seq: 0 });
  await settle();
  await a;
  // once answered, the same command is a new run
  void commands.run(followUp, { id: S1, text: 'go' });
  assert.equal(mutates().length, 2);
  assert.notEqual(mutates()[0]?.mid, mutates()[1]?.mid);
});

test('offline: the command waits, then goes after the welcome; a lost stream resends it with the same mid', async () => {
  const { commands, mutates, conn, clock, reader, writer } = await setup(memoryPersist(), { connect: false });
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'old' } }]);
  const done = commands.run(rename, { id: S1, title: 'offline' });
  assert.equal(reader.peek<{ title: string }>('session', S1)?.title, 'offline', 'shown at once, even offline');
  assert.equal(mutates().length, 0);
  assert.equal(commands.pending()()[0]?.waiting, true, 'waiting for the peer');
  conn().push(welcome());
  await settle();
  assert.equal(mutates().length, 1);
  assert.equal(commands.pending()()[0]?.waiting, false);
  const mid = mutates()[0]?.mid;
  conn().end(new Error('tunnel dropped'));
  await settle();
  clock.advance(500); // the link's first retry
  await settle();
  conn().push(welcome({ resume: true }));
  await settle();
  assert.equal(mutates().length, 2);
  assert.equal(mutates()[1]?.mid, mid, 'the same idempotency key: the peer runs it once');
  conn().push({ t: 'ack', mid: mid ?? '', seq: 0 });
  await settle();
  await done;
});

test('pending commands survive a reload: the overlay is back on first paint and resent with the same mid', async () => {
  const persist = memoryPersist();
  const first = await setup(persist, { connect: false });
  first.writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'old' } }]);
  void first.commands.run(rename, { id: S1, title: 'kept' });
  await settle();
  first.scope.dispose();
  const saved = (await persist.entries('pending'))[0]?.[1] as { mid: string } | undefined;
  assert.ok(saved);

  const second = await setup(persist, { connect: false });
  second.writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'old' } }]);
  await second.commands.restore();
  assert.equal(second.reader.peek<{ title: string }>('session', S1)?.title, 'kept');
  // running it again joins the restored one instead of sending a second
  void second.commands.run(rename, { id: S1, title: 'kept' });
  second.conn().push(welcome());
  await settle();
  assert.deepEqual(second.mutates().map((m) => m.mid), [saved.mid]);
  second.conn().push({ t: 'ack', mid: saved.mid, seq: 0 });
  await settle();
  assert.deepEqual(await persist.entries('pending'), [], 'the answer clears it from disk');
});

test('a peer without the feature refuses the command at once, with the reason, and sends nothing', async () => {
  const { commands, mutates, errors } = await setup();
  const crew = defineCommand<{ peer: string }>({ id: 'crew.hire', owner: (a) => a.peer, optimistic: 'none', pending: 'the crew.hire control', feature: { plugin: 'wisp.crew', label: 'Crew' } });
  await assert.rejects(commands.run(crew, { peer: 'laptop' }), /Crew isn't installed on laptop/);
  assert.equal(mutates().length, 0);
  assert.equal(errors[0]?.code, 'unavailable');
});

test('an optimistic patch that throws fails the command as invalid instead of breaking the store', async () => {
  const { commands, reader } = await setup();
  const broken = defineCommand<{ id: EntityKey }>({
    id: 'x.broken',
    owner: (a) => a.id,
    optimistic: () => {
      throw new Error('no such row');
    },
  });
  await assert.rejects(commands.run(broken, { id: S1 }), (e: unknown) => e instanceof CommandError && e.code === 'invalid');
  assert.equal(reader.pending()().length, 0);
});

test('commands route to the peer named in the id (origin routing)', async () => {
  const { peers, commands, scope } = await setup();
  const box = fakeTransport();
  peers.add({ peer: peerId('box'), name: 'box', transport: box });
  await settle();
  box.connections[0]?.push(welcome({}, { peer: 'box', name: 'box' }));
  await settle();
  void commands.run(followUp, { id: entityKey(peerId('box'), 's9'), text: 'hi' });
  assert.equal(box.posted.filter((m) => m.t === 'mutate').length, 1);
  scope.dispose();
});

test('the type requires optimistic: a command without one does not compile', () => {
  // @ts-expect-error: optimistic is required (a patch or 'none')
  defineCommand<{ id: string }>({ id: 'x.y', owner: (a) => a.id });
  assert.ok(true);
});

test('a command with no optimistic result names the control that shows it in flight (design/feedback.md)', () => {
  // @ts-expect-error `optimistic: 'none'` alone: nothing on screen would answer the action
  const bare = defineCommand<{ id: string }>({ id: 'x.y', owner: (a) => a.id, optimistic: 'none' });
  const named = defineCommand<{ id: string }>({ id: 'x.y', owner: (a) => a.id, optimistic: 'none', pending: 'the Ship it button' });
  assert.equal(bare.optimistic, 'none');
  assert.equal(named.pending, 'the Ship it button');
});

test('a command\'s wire shape: the peer gets the args as its command takes them (an entity key as the bare id)', async () => {
  const { commands, mutates } = await setup();
  const view = defineCommand<{ key: EntityKey }>({ id: 'ship.view', owner: (a) => a.key, wire: (a) => ({ session: a.key.slice(a.key.indexOf(':') + 1) }), optimistic: 'none', pending: 'the ship.view control' });
  void commands.run(view, { key: S1 }).catch(() => undefined);
  assert.deepEqual(mutates()[0]?.args, { session: 's1' });
});
