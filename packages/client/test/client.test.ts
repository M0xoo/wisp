import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '../src/client.ts';
import { entityKey, peerId } from '../src/ids.ts';
import { memoryHistory } from '../src/nav-url.ts';
import { memoryPersist } from '../src/persist.ts';
import { setSetting } from '../src/settings.ts';
import type { EntityKey, SessionId } from '../src/types.ts';
import { fakeTimers, type FakeTimers, fakeTransport, tick, welcome } from './helpers.ts';

const A = peerId('laptop');
const S1 = entityKey(A, 's1');

let clockNow: FakeTimers | undefined; // the running test's clock
/** lets streams deliver and zero-delay timers (a peer's first open) run */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    clockNow?.advance(0);
    await tick();
  }
}

function make(persist = memoryPersist(), url = '/') {
  const clock = fakeTimers(1_700_000_000_000);
  clockNow = clock;
  const errors: string[] = [];
  const history = memoryHistory(url);
  const client = createClient({ clientId: 'c1', build: 'test', home: A, width: 1280, persist, timers: clock, history, onError: (e) => errors.push(e.message) });
  return { client, clock, persist, errors, history };
}

test('first paint: rows, cursor, drafts and the last place come back from disk before any peer answers', async () => {
  const persist = memoryPersist();
  const one = make(persist);
  const t = fakeTransport();
  await one.client.start([{ peer: A, name: 'laptop', transport: t }]);
  one.client.peers.watch(A, 'list', one.client.scope);
  await settle();
  t.connections.at(-1)?.push(welcome({ epoch: 'ep' }));
  await settle();
  t.connections.at(-1)?.frame(12, { t: 'snapshot', topic: 'list', seq: 12, rows: [{ e: 'session', id: 's1', v: { title: 'hello' } }] });
  await settle();
  one.client.drafts.set(S1, 'composer', 'half a thought');
  one.client.nav.navigate({ t: 'openTask', id: S1 as string as SessionId });
  await one.client.flush();
  one.client.dispose();

  const two = make(persist);
  const t2 = fakeTransport();
  await two.client.start([{ peer: A, name: 'laptop', transport: t2 }]);
  two.client.peers.watch(A, 'list', two.client.scope);
  assert.deepEqual(two.client.entities.peek('session', S1), { title: 'hello' }, 'painted from disk');
  assert.equal(two.client.drafts.get(S1, 'composer')(), 'half a thought');
  assert.deepEqual(two.client.nav.nav().main, { kind: 'task', id: S1 });
  await settle();
  const params = t2.connections.at(-1)?.params;
  assert.equal(params?.['epoch'], 'ep');
  assert.equal(params?.['cursor'], '12', 'the hello resumes from the saved cursor');
  assert.equal(params?.['topics'], 'list', 'the saved topic resumes instead of taking a snapshot');
  two.client.dispose();
});

test('plugins get the same APIs, owned by their scope: stores, views, strings, settings, machines', async () => {
  const { client } = make();
  const crew = client.plugin('crew');
  crew.strings({ 'crew.title': 'Crew' });
  const view = crew.registerView({ id: 'crew.board', slot: 'main', parse: (p) => (p === null ? null : undefined) });
  const settings = crew.settings([
    { key: 'crew.size', type: 'int', min: 1, max: 9, default: 3, scope: 'device' },
    { key: 'crew.mode', type: 'enum', values: ['auto', 'manual'], default: 'auto' },
  ] as const);
  const size: number = settings.get('crew.size')();
  assert.equal(size, 3);
  await settings.set('crew.size', 5);
  assert.equal(settings.get('crew.size')(), 5);
  await assert.rejects(settings.set('crew.size', 12), /at most 9/);
  const m = crew.machine({ id: 'crew.hire', initial: 'idle', states: { idle: { on: { GO: 'busy' } }, busy: {} } }, undefined);
  m.send('GO');
  assert.deepEqual(client.devtools.machines(), { 'crew.hire': 'busy' });
  crew.navigate(view.open(null));
  assert.equal(client.nav.nav().main.kind, 'view');
  assert.equal(client.i18n.t('crew.title'), 'Crew');

  crew.scope.dispose(); // the plugin is switched off
  assert.equal(client.i18n.t('crew.title'), 'crew.title');
  assert.deepEqual(client.devtools.machines(), {});
  assert.equal(m.alive, false);
  client.nav.navigate({ t: 'home' });
  client.nav.navigate(view.open(null));
  assert.equal(client.nav.nav().main.kind, 'home');
  assert.throws(() => client.plugin('git').registerView({ id: 'crew.steal', slot: 'main', parse: () => null }), /can't register/);
  client.dispose();
});

test('server settings are written by command, optimistic, and a locked one refuses', async () => {
  const { client, errors } = make();
  const t = fakeTransport();
  await client.start([{ peer: A, name: 'laptop', transport: t }]);
  client.peers.watch(A, 'config', client.scope);
  await settle();
  t.connections.at(-1)?.push(welcome());
  await settle();
  t.connections.at(-1)?.frame(3, {
    t: 'snapshot',
    topic: 'config',
    seq: 3,
    rows: [
      { e: 'setting', id: 'claude.model', v: { key: 'claude.model', value: 'opus' } },
      { e: 'setting', id: 'claude.effort', v: { key: 'claude.effort', value: 'high', locked_by: 'acme.policy' } },
    ],
  });
  await settle();
  const s = client.plugin('claude').settings([
    { key: 'claude.model', type: 'string', default: 'sonnet' },
    { key: 'claude.effort', type: 'enum', values: ['low', 'high'], default: 'low' },
  ] as const);
  assert.equal(s.get('claude.model')(), 'opus');
  void s.set('claude.model', 'haiku');
  assert.equal(s.get('claude.model')(), 'haiku', 'shown at once');
  const mutate = t.posted.find((m) => m.t === 'mutate');
  assert.equal(mutate?.t === 'mutate' && mutate.cmd, setSetting.id);
  assert.equal(s.lockedBy('claude.effort')(), 'acme.policy');
  await assert.rejects(s.set('claude.effort', 'low'), /set by acme.policy/);
  assert.deepEqual(errors, []);
  client.dispose();
});

test('a share link names a task: the URL wins over the last place', async () => {
  const persist = memoryPersist();
  await persist.write([{ ns: 'nav', key: 'last', value: '/task/laptop%3As1' }]);
  const { client } = make(persist, '/task/box%3As2');
  await client.start([]);
  assert.deepEqual(client.nav.nav().main, { kind: 'task', id: 'box:s2' as EntityKey });
  client.dispose();
});

test('a plugin translates, watches topics in its scope and reads peers, nothing more', async () => {
  const { client } = make();
  const inputs: string[] = [];
  const link = { peer: A, cursor: null, handle: (i: { kind: string; topic?: string }) => (inputs.push(`${i.kind} ${i.topic ?? ''}`.trim()), []), save: () => ({}) as never };
  await client.start([{ peer: A, name: 'laptop', transport: fakeTransport(), link }]);
  const mac = client.plugin('machine');
  mac.strings({ 'machine.title': 'This {os}' });
  assert.equal(mac.t('machine.title', { os: 'Mac' }), 'This Mac');
  assert.equal(mac.home, A);
  assert.deepEqual(mac.peers.list()(), [A]);
  assert.equal(mac.peers.name(A), 'laptop');
  const pane = mac.scope.child('pane');
  mac.watch(A, 'plugin:wisp.machine:snapshot', pane);
  assert.ok(inputs.includes('subscribe plugin:wisp.machine:snapshot'));
  pane.dispose();
  assert.ok(inputs.includes('unsubscribe plugin:wisp.machine:snapshot'), 'the owner scope ends the subscription');
  assert.equal('add' in mac.peers, false, 'a plugin cannot add or remove peers');
  client.dispose();
});

test('a plugin writes drafts into the one drafts store (the composer keeps its text there)', async () => {
  const { client } = make();
  const composer = client.plugin('wisp.shell-composer');
  composer.drafts.set('box:s1', 'text', 'half a reply');
  assert.equal(client.drafts.get('box:s1', 'text')(), 'half a reply');
  composer.drafts.clear('box:s1', 'text');
  assert.equal(client.drafts.get('box:s1', 'text')(), undefined);
  client.dispose();
});

test('plugin_clients_are_one_per_plugin_while_their_scope_lives: settings declared once however often a plugin is asked for', () => {
  const { client } = make(memoryPersist());
  const a = client.plugin('composer');
  assert.equal(client.plugin('composer'), a, 'the same client: its settings, stores and caches are made once');
  a.settings([{ key: 'composer.followUp', type: 'enum', values: ['interrupt', 'queue'], default: 'interrupt', scope: 'server' }] as never);
  assert.doesNotThrow(() => client.plugin('composer'));
  // switched off: its scope ends, the next ask is a fresh client that may declare its settings again
  a.scope.dispose();
  const b = client.plugin('composer');
  assert.notEqual(b, a);
  assert.doesNotThrow(() => b.settings([{ key: 'composer.followUp', type: 'enum', values: ['interrupt', 'queue'], default: 'interrupt', scope: 'server' }] as never));
});
