import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, type SessionId } from '@wisp/client';
import { capacitorBridge, exposePlugins, type CapacitorLike } from '../src/bridge.ts';
import { back } from '../src/boot.ts';
import { fromV1, migrateV1 } from '../src/migrate.ts';
import { PHONE } from '../src/peers.ts';
import { fakeBridge } from './helpers.ts';

function fakeCapacitor(answers: Record<string, unknown>) {
  const calls: [string, string, unknown][] = [];
  const listeners = new Map<string, (d: unknown) => void>();
  let removed = 0;
  const cap: CapacitorLike = {
    isNativePlatform: () => true,
    nativePromise: async (plugin, method, args) => {
      calls.push([plugin, method, args]);
      return answers[method];
    },
    addListener: (plugin, event, fn) => {
      listeners.set(`${plugin}.${event}`, fn);
      return { remove: () => (removed += 1) };
    },
  };
  return { cap, calls, listeners, removed: () => removed };
}

test('capacitorBridge calls WispSsh through Capacitor’s native bridge and reads its answers safely', async () => {
  const f = fakeCapacitor({
    list: { computers: [{ id: 'a', kind: 'ssh', name: 'Studio', target: 'me@studio', port: 4477 }, { id: 'g', kind: 'grid', url: 'https://mo.grid', token: 't' }, { id: 'z', kind: 'carrier-pigeon' }, { kind: 'ssh' }] },
    connect: { kind: 'ssh', port: 5001, token: 'wlt', name: 'Studio', peer: 'studio-1f3a' },
  });
  const b = capacitorBridge(f.cap);
  assert.deepEqual(await b.list(), [
    { id: 'a', kind: 'ssh', name: 'Studio', target: 'me@studio', port: 4477 },
    { id: 'g', kind: 'grid', name: 'g', url: 'https://mo.grid', token: 't' },
  ]);
  assert.deepEqual(await b.connect('a', { password: 'pw' }), { kind: 'ssh', port: 5001, token: 'wlt', name: 'Studio', peer: 'studio-1f3a' });
  await b.disconnect('a');
  await b.save({ id: 'a', peer: 'studio-1f3a' });
  assert.deepEqual(f.calls.slice(1), [
    ['WispSsh', 'connect', { id: 'a', password: 'pw' }],
    ['WispSsh', 'disconnect', { id: 'a' }],
    ['WispSsh', 'saveComputer', { computer: { id: 'a', peer: 'studio-1f3a' } }],
  ]);
});

test('a connect answer with no port is refused, not guessed', async () => {
  const b = capacitorBridge(fakeCapacitor({ connect: { kind: 'ssh', token: '' } }).cap);
  await assert.rejects(b.connect('a'), /no port/);
});

test('events: tunnel states, Back, and a tapped notification’s target; removing a listener removes it natively', async () => {
  const f = fakeCapacitor({});
  const b = capacitorBridge(f.cap);
  const seen: unknown[] = [];
  const off = b.onTunnel((e) => seen.push(e));
  b.onBack(() => seen.push('back'));
  b.onOpen((t) => seen.push(t));
  f.listeners.get('WispSsh.tunnel')?.({ id: 'a', state: 'ready', line: '@@wisp open 2.0.0' });
  f.listeners.get('WispSsh.back')?.({});
  f.listeners.get('WispSsh.open')?.({ target: '{"to":"main","main":{"kind":"home"}}' });
  f.listeners.get('WispSsh.open')?.({ target: 'not json' });
  assert.deepEqual(seen, [{ id: 'a', state: 'ready', line: '@@wisp open 2.0.0' }, 'back', { to: 'main', main: { kind: 'home' } }]);
  off();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.removed(), 1);
});

test('outside the app the bridge says so instead of hanging', async () => {
  await assert.rejects(capacitorBridge(undefined).list(), /not in the Android app/);
});

test('exposePlugins fills Capacitor.Plugins for the shell’s androidPlatform, leaving real ones alone', async () => {
  const f = fakeCapacitor({ openExternal: undefined, schedule: { notifications: [] } });
  const own = { share: async () => 'mine' };
  f.cap.Plugins = { Share: own };
  exposePlugins(f.cap, ['WispSsh', 'LocalNotifications', 'Share']);
  await f.cap.Plugins['WispSsh']?.['openExternal']?.({ url: 'https://trywisp.dev' });
  await f.cap.Plugins['LocalNotifications']?.['schedule']?.({ notifications: [{ id: 1, title: 'Done' }] });
  assert.equal(f.cap.Plugins['Share'], own);
  assert.deepEqual(f.calls, [
    ['WispSsh', 'openExternal', { url: 'https://trywisp.dev' }],
    ['LocalNotifications', 'schedule', { notifications: [{ id: 1, title: 'Done' }] }],
  ]);
});

test('v1’s computers: SSH ones keep their target, port and key; v1’s npx command becomes the v2 binary; grid accounts bring their computers', () => {
  assert.deepEqual(fromV1({ id: 'k3', target: 'me@studio:2222', port: 4478, keyId: 'key1', command: 'npx -y wisp-agents@latest', lastUsed: 1 }), [
    { id: 'k3', kind: 'ssh', name: 'studio', target: 'me@studio:2222', port: 4478, keyId: 'key1' },
  ]);
  assert.deepEqual(fromV1({ id: 'k4', name: 'Lab', target: 'me@lab', command: 'node ~/wisp/bin/wisp.js' })[0], { id: 'k4', kind: 'ssh', name: 'Lab', target: 'me@lab', command: 'node ~/wisp/bin/wisp.js' });
  assert.deepEqual(fromV1({ id: 'g1', kind: 'grid', grid: 'https://grid.trywisp.dev', url: 'https://mo.grid.trywisp.dev', handle: 'mo', name: 'wisp Cloud', token: 'dev', computers: [{ id: 'c9', name: 'Studio', url: 'https://studio--mo.grid.trywisp.dev', online: true }, { id: 'bad' }] }), [
    { id: 'g1', kind: 'grid', name: 'wisp Cloud', url: 'https://mo.grid.trywisp.dev', token: 'dev', grid: 'https://grid.trywisp.dev' },
    { id: 'g1.c9', kind: 'grid', name: 'Studio', url: 'https://studio--mo.grid.trywisp.dev', token: 'dev', computer: 'c9', grid: 'https://grid.trywisp.dev' },
  ]);
  assert.deepEqual(fromV1({ id: 'g2', kind: 'grid', url: 'https://x', token: 'dev', signedOut: true }), [], 'signed out: nothing to reach it with');
  assert.deepEqual(fromV1({ name: 'no id' }), []);
});

test('migrateV1 copies them once, skipping ones already on the device, and leaves v1’s list as it was', async () => {
  const v1 = JSON.stringify([{ id: 'a', target: 'me@a' }, { id: 'b', target: 'me@b' }]);
  const store = new Map<string, string>([['wisp.machines', v1]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const bridge = fakeBridge([{ id: 'a', kind: 'ssh', name: 'kept', target: 'me@a' }]);
  assert.equal(await migrateV1(storage, bridge), 1);
  assert.deepEqual(bridge.computers.map((c) => [c.id, c.name]), [['a', 'kept'], ['b', 'b']]);
  assert.equal(await migrateV1(storage, bridge), 0, 'only once');
  assert.equal(store.get('wisp.machines'), v1);
  store.set('wisp.machines', '{broken');
  store.delete('wisp.machines.v2');
  assert.equal(await migrateV1(storage, bridge), 0, 'a damaged list brings nothing');
});

test('Back closes what is open; with nothing left it leaves the app', () => {
  const bridge = fakeBridge();
  const client = createClient({ clientId: 'p', build: 'test', home: PHONE, width: 390 });
  client.nav.navigate({ t: 'openTask', id: 'ssh-a:s1' as SessionId });
  assert.equal(client.nav.nav()().main.kind, 'task');
  back(client, bridge);
  assert.equal(bridge.leaves, 0, 'it closed the task');
  assert.equal(client.nav.nav()().main.kind, 'home');
  back(client, bridge);
  assert.equal(bridge.leaves, 1, 'nothing left: the app goes behind');
  client.dispose();
});
