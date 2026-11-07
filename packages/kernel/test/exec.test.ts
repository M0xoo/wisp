// The exec tier (plan §6.7 tier 3): a plugin as a child process over JSON-RPC on stdio. Same
// PluginContext calls, same permissions and traces, crash isolation with restart and backoff.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { defineService, Kernel, RpcPeer, type EventEnvelope, type KernelOptions, type Manifest, type PluginContext } from '../src/index.ts';
import { def, manifest, rejection, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/echo-plugin.ts', import.meta.url));
const user = { set: 'user:full' } as const;
const hostService = defineService<{ read(): Promise<number>; write(): Promise<string> }>('host.service', 1, { read: 'host:read', write: 'host:write' }, ['read']);
const commands = ['say', 'nested', 'loop', 'hook', 'service', 'write', 'setting', 'crash', 'unavailable', 'parsed'].map((c) => ({ id: `echo.${c}`, title: c }));

function echoManifest(mode = 'ok', extra: Partial<Manifest> = {}): Manifest {
  return manifest('acme.echo', {
    server: { exec: [process.execPath, fixture, mode] },
    requires: { 'host.service': '^1' },
    permissions: ['host:read', 'host:record'],
    contributes: { commands, events: ['echo.said'], settings: [{ key: 'echo.greeting', type: 'string', default: 'hi' }] },
    ...extra,
  });
}

interface World {
  k: Kernel;
  events: EventEnvelope[];
  records: unknown[];
  host: () => PluginContext;
  warnings: string[];
}

async function world(mode = 'ok', o: KernelOptions = {}, extra: Partial<Manifest> = {}): Promise<World> {
  const warnings: string[] = [];
  const k = new Kernel({ log: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {} }, ...o });
  const events: EventEnvelope[] = [];
  const records: unknown[] = [];
  let hostCtx: PluginContext | undefined;
  k.register(
    manifest('wisp.host', {
      provides: { 'host.service': { version: '1.0.0' } },
      contributes: { commands: [{ id: 'host.read', title: 'r' }, { id: 'host.record', title: 'rec' }, { id: 'host.go', title: 'go' }], events: ['host.ping'], points: [{ id: 'host.list', version: 1, kind: 'list' }] },
    }),
    {
      def: def('wisp.host', (ctx) => {
        hostCtx = ctx;
        ctx.provide(hostService, { read: async () => 7, write: async () => 'wrote' });
        ctx.command({ id: 'host.read', readOnly: true, run: (_a, call) => call.trace.depth });
        ctx.command({ id: 'host.record', run: (a) => void records.push(a) });
        ctx.command({ id: 'host.go', run: (a, call) => call.runHook('before:go', a) });
        ctx.on('echo.*', (e) => void events.push(e));
      }),
    },
  );
  k.register(echoManifest(mode, extra), { root: process.cwd() });
  await k.start();
  return { k, events, records, warnings, host: () => hostCtx ?? assert.fail() };
}

const state = (k: Kernel, id = 'acme.echo') => k.status().find((s) => s.id === id);

test('an exec plugin registers commands, interceptors, subscriptions and contributions over RPC', async () => {
  const w = await world();
  try {
    assert.equal(state(w.k)?.state, 'active', state(w.k)?.reason);
    assert.equal(state(w.k)?.trust, 'untrusted', 'code that is not built in defaults to untrusted');
    assert.deepEqual(await w.k.run('echo.say', { a: 1 }, user), { echoed: { a: 1 } });
    await w.k.idle();
    assert.equal(w.events[0]?.type, 'echo.said');
    assert.equal(w.events[0]?.plugin, 'acme.echo');
    // a nested call from the child continues the trace
    assert.deepEqual(await w.k.run('echo.nested', {}, user), { depth: 0, inner: 1 });
    assert.equal((await rejection(w.k.run('echo.loop', {}, user))).code, 'reentrant_hook');
    assert.equal(await w.k.run('echo.parsed', '21', user), 42);
    // its interceptor runs with the kernel's time budget and verdict rules
    assert.deepEqual(await w.k.run('host.go', { n: 1 }, user), { n: 101 });
    const veto = await rejection(w.k.run('host.go', { n: 9 }, user));
    assert.equal(veto.message, '9 is too big');
    // a command in the child can run a hook too
    assert.deepEqual(await w.k.run('echo.hook', { n: 2 }, user), { n: 102 });
    assert.deepEqual(w.k.contributions('host.list').map((c) => c.by), ['acme.echo']);
    // events reach it, and what it runs from a handler is checked against its permissions
    w.host().emit('host.ping', { x: 1 });
    await until(() => w.records.length === 1, 3000, 'the child to record the ping');
    assert.equal((w.records[0] as { from: string }).from, 'child');
    await until(() => w.warnings.some((m) => m.includes('stdout stays clean')), 3000, 'stderr to reach the log');
  } finally {
    w.k.stop();
  }
});

test('services from the child: the provider’s permission map is enforced, not the child’s', async () => {
  const w = await world();
  try {
    assert.deepEqual(await w.k.run('echo.service', {}, user), { read: 7 });
    const e = await rejection(w.k.run('echo.write', {}, user));
    assert.equal(e.code, 'forbidden');
    assert.match(e.message, /plugin:acme\.echo may not host:write/);
    assert.equal((await rejection(w.k.run('echo.unavailable', {}, user))).code, 'unavailable');
  } finally {
    w.k.stop();
  }
});

test('settings reach the child and changes follow', async () => {
  const w = await world();
  try {
    assert.equal(await w.k.run('echo.setting', {}, user), 'hi');
    w.k.settings.set('echo.greeting', 'hello');
    await until(() => w.events.some((e) => e.type === 'echo.greetingChanged'), 3000, 'the watcher');
    assert.equal(await w.k.run('echo.setting', {}, user), 'hello');
  } finally {
    w.k.stop();
  }
});

test('a dead child is the plugin off with the reason, then a restart with backoff', async () => {
  const w = await world('ok', { exec: { restartBaseMs: 30, maxRestarts: 2 } });
  try {
    const e = await rejection(w.k.run('echo.crash', {}, user));
    assert.equal(e.code, 'unavailable');
    await until(() => state(w.k)?.state === 'off', 3000, 'off');
    assert.equal(state(w.k)?.reason, "acme.echo's process exited (code 3); restarting in 30 ms");
    assert.equal(w.k.diagnostics.failures('acme.echo').at(-1)?.kind, 'exec');
    await until(() => state(w.k)?.state === 'active', 5000, 'restart');
    assert.deepEqual(await w.k.run('echo.say', 1, user), { echoed: 1 });
    await rejection(w.k.run('echo.crash', {}, user));
    await until(() => state(w.k)?.reason?.includes('restarting in 60 ms') ?? false, 3000, 'the second backoff doubles');
    await until(() => state(w.k)?.state === 'active', 5000, 'second restart');
    await rejection(w.k.run('echo.crash', {}, user));
    await until(() => state(w.k)?.reason?.includes('gave up after 2 restarts') ?? false, 3000, 'giving up');
    // the host is untouched by all of it
    assert.equal(state(w.k, 'wisp.host')?.state, 'active');
  } finally {
    w.k.stop();
  }
});

test('setup that fails in the child, or never finishes, turns the plugin off with why', async () => {
  const bad = await world('bad-setup');
  assert.equal(state(bad.k)?.state, 'off');
  assert.match(state(bad.k)?.reason ?? '', /acme\.echo failed to start: no config file/);
  bad.k.stop();
  const hang = await world('hang', { exec: { initTimeoutMs: 200 } });
  assert.match(state(hang.k)?.reason ?? '', /didn't finish setup within 200 ms/);
  hang.k.stop();
});

test('a program that does not exist is a failed start, not a crash of the kernel', async () => {
  const k = new Kernel({ exec: { maxRestarts: 0 } });
  k.register(manifest('acme.ghost', { server: { exec: ['/definitely/not/here'] } }));
  await k.start();
  await until(() => state(k, 'acme.ghost')?.state === 'off', 3000, 'off');
  assert.match(state(k, 'acme.ghost')?.reason ?? '', /acme\.ghost/);
  k.stop();
});

test('switching an exec plugin off kills the child; its commands go with it', async () => {
  const w = await world();
  await w.k.deactivate('acme.echo');
  assert.equal((await rejection(w.k.run('echo.say', {}, user))).code, 'not_found');
  assert.deepEqual(w.k.inspect('acme.echo'), { scope: 0, commands: 0, interceptors: 0, subscriptions: 0, provided: 0, handles: 0, contributions: 0, queued: 0 });
  w.k.stop();
});

test('JSON-RPC framing: split lines, bad JSON, unknown methods, notifications, errors with codes', async () => {
  const aIn = new PassThrough();
  const bIn = new PassThrough();
  const a = new RpcPeer(aIn, bIn, () => undefined);
  const seen: string[] = [];
  const b = new RpcPeer(bIn, aIn, (m, p) => {
    seen.push(m);
    if (m === 'add') return (p as number[]).reduce((x, y) => x + y, 0);
    if (m === 'refuse') throw { code: 'forbidden', message: 'no', retry: false };
    if (m === 'later') return Promise.reject(new Error('async no'));
    throw Object.assign(new Error('no method ' + m), { code: 'not_found' });
  });
  assert.equal(await a.request('add', [1, 2, 3]), 6);
  const r = await rejection(a.request('refuse'));
  assert.equal(r.code, 'forbidden');
  assert.equal((await rejection(a.request('later'))).message, 'async no');
  assert.equal((await rejection(a.request('nope'))).code, 'not_found');
  a.notify('ping', { x: 1 });
  // a line split across chunks, and a line that isn't JSON
  bIn.write('{"jsonrpc":"2.0","method":"sp');
  bIn.write('lit"}\n');
  aIn.write('not json\n');
  await until(() => seen.includes('split'), 1000, 'split line');
  assert.ok(seen.includes('ping'));
  a.close('done');
  assert.ok(a.closed);
  assert.equal((await rejection(a.request('add', []))).code, 'unavailable');
  b.close('done');
});
