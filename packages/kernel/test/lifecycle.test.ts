// Kernel lifecycle (plan §6.3, §6.4): register, resolve, lazy activation, deactivate cascades with
// reasons, reactivate brings them back, and switching off leaks nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, defineService, Kernel, pluginGroup, type PluginContext } from '../src/index.ts';
import { def, manifest, rejection, sleep } from './helpers.ts';

const user = { set: 'user:full' } as const;

test('a plugin with no activation starts at startup; a lazy one waits for its event', async () => {
  const k = new Kernel();
  const started: string[] = [];
  k.register(manifest('wisp.eager'), { def: def('wisp.eager', () => void started.push('eager')) });
  k.register(manifest('wisp.claude', { activation: ['onCommand:runtime.start{harness:claude}'], contributes: { commands: [{ id: 'claude.login', title: 'Sign in' }] } }), {
    def: def('wisp.claude', (ctx) => {
      started.push('claude');
      ctx.command({ id: 'claude.login', run: () => 'signed in' });
    }),
  });
  k.register(manifest('wisp.view', { activation: ['onView:shell.usage', 'onTopic:session:*', 'onBlock:usage', 'onSchedule:nightly'] }), { def: def('wisp.view', () => void started.push('view')) });
  await k.start();
  assert.deepEqual(started, ['eager']);
  assert.equal(k.status().find((s) => s.id === 'wisp.claude')?.state, 'resolved');
  // implicit onCommand: a command the manifest lists wakes its plugin
  assert.equal(await k.run('claude.login', {}, user), 'signed in');
  assert.deepEqual(started, ['eager', 'claude']);
  assert.deepEqual(await k.fire('onTopic', 'list'), []);
  assert.deepEqual(await k.fire('onTopic', 'session:42'), ['wisp.view']);
  assert.deepEqual(await k.fire('onView', 'shell.usage'), [], 'already active');
});

test('onCommand activation can be narrowed by args', async () => {
  const k = new Kernel();
  const started: string[] = [];
  k.register(manifest('wisp.claude', { activation: ['onCommand:runtime.start{harness:claude}'] }), { def: def('wisp.claude', () => void started.push('claude')) });
  k.register(manifest('wisp.codex', { activation: ['onCommand:runtime.start{harness:codex}'] }), { def: def('wisp.codex', () => void started.push('codex')) });
  await k.start();
  await k.fire('onCommand', 'runtime.start', { harness: 'codex' });
  await k.fire('onCommand', 'runtime.start', 'not an object');
  assert.deepEqual(started, ['codex']);
});

test('activating a plugin activates what it requires first, including resolved optional ones', async () => {
  const k = new Kernel();
  const order: string[] = [];
  k.register(manifest('wisp.claude', { activation: ['onView:x'], kind: 'module', extends: 'wisp.runtime', requires: { 'wisp.git': { version: '*', optional: true } } }), { def: def('wisp.claude', () => void order.push('claude')) });
  k.register(manifest('wisp.runtime', { activation: ['onView:never'] }), { def: def('wisp.runtime', () => void order.push('runtime')) });
  k.register(manifest('wisp.git', { activation: ['onView:never'] }), { def: def('wisp.git', () => void order.push('git')) });
  await k.start();
  await k.fire('onView', 'x');
  assert.deepEqual(order, ['runtime', 'git', 'claude']);
});

test('deactivate cascades with the exact reason; reactivate brings dependents back', async () => {
  const k = new Kernel();
  const off: unknown[] = [];
  k.register(manifest('wisp.runtime'), { def: def('wisp.runtime', () => undefined), builtin: true });
  k.register(manifest('wisp.claude', { kind: 'module', extends: 'wisp.runtime' }), { def: def('wisp.claude', () => undefined), builtin: true });
  k.register(manifest('wisp.crew', { requires: { 'wisp.claude': '^1' } }), { def: def('wisp.crew', () => undefined) });
  k.register(manifest('wisp.watcher'), { def: def('wisp.watcher', (ctx) => ctx.on('kernel.pluginOff', (e) => void off.push(e.data))) });
  await k.start();
  const gone = await k.deactivate('wisp.runtime');
  assert.deepEqual(gone, [
    { id: 'wisp.runtime', reason: 'wisp.runtime was switched off' },
    { id: 'wisp.claude', reason: 'wisp.claude extends wisp.runtime, which is off' },
    { id: 'wisp.crew', reason: 'wisp.crew requires wisp.claude, which is refused (wisp.claude extends wisp.runtime, which is off)' },
  ]);
  const st = Object.fromEntries(k.status().map((s) => [s.id, s]));
  assert.equal(st['wisp.runtime']?.state, 'off');
  assert.equal(st['wisp.claude']?.state, 'refused');
  assert.equal(st['wisp.claude']?.trust, 'trusted');
  assert.equal(st['wisp.crew']?.trust, 'declarative');
  await k.idle();
  assert.deepEqual(off.map((d) => (d as { plugin: string }).plugin), ['wisp.crew', 'wisp.claude', 'wisp.runtime'], 'dependents go first');
  assert.equal(await k.reactivate('wisp.runtime'), 'active');
  assert.ok(k.status().every((s) => s.state === 'active'));
  await assert.rejects(k.deactivate('nope.x'), /no plugin nope\.x/);
  await assert.rejects(k.reactivate('nope.x'), /no plugin nope\.x/);
});

test('a plugin whose setup throws is off with the reason, and so is what requires it', async () => {
  const k = new Kernel();
  k.register(manifest('wisp.bad'), { def: def('wisp.bad', () => Promise.reject(new Error('no config'))) });
  k.register(manifest('wisp.user', { requires: { 'wisp.bad': '*' } }), { def: def('wisp.user', () => undefined) });
  await k.start();
  const st = Object.fromEntries(k.status().map((s) => [s.id, s]));
  assert.equal(st['wisp.bad']?.reason, 'wisp.bad failed to start: no config');
  assert.match(st['wisp.user']?.reason ?? '', /wisp\.user requires wisp\.bad, which is off/);
  assert.equal(k.diagnostics.failures('wisp.bad')[0]?.kind, 'setup');
});

test('registration refuses bad manifests, duplicates and a def that names another plugin', () => {
  const k = new Kernel();
  assert.throws(() => k.register({ id: 'x' }), (e: { code: string; details: { errors: unknown[] } }) => e.code === 'invalid' && e.details.errors.length > 0);
  assert.throws(() => k.register(null), /manifest \?/);
  k.register(manifest('a.b'));
  assert.throws(() => k.register(manifest('a.b')), /already registered/);
  assert.throws(() => k.register(manifest('a.c'), { def: def('a.d', () => undefined) }), /says it is a\.d/);
});

test('plugin groups: a disabled plugin is registered off and keeps its slot', async () => {
  const k = new Kernel();
  const Default = pluginGroup('default', [{ manifest: manifest('wisp.runtime') }, { manifest: manifest('wisp.telemetry') }]);
  k.addGroup(build(Default).disable('wisp.telemetry').add({ manifest: manifest('me.mine'), builtin: false, def: def('me.mine', () => undefined) }).finish());
  await k.start();
  const st = k.status();
  assert.deepEqual(st.map((s) => [s.id, s.state, s.builtin]), [
    ['wisp.runtime', 'active', true],
    ['wisp.telemetry', 'off', true],
    ['me.mine', 'active', false],
  ]);
  assert.equal(st[1]?.reason, 'wisp.telemetry is disabled in the group default');
  k.register(manifest('late.one'), { enabled: false });
  k.register(manifest('late.two'), { enabled: 'not today' });
  await sleep(1);
  assert.equal(k.status().find((s) => s.id === 'late.two')?.reason, 'not today');
});

test('deactivate leaks nothing: commands, interceptors, subscriptions, services, handles, timers, contributions', async () => {
  const k = new Kernel();
  const ref = defineService<{ ping(): string }>('pong.service', 1, { ping: 'pong:ping' });
  let ticks = 0;
  k.register(manifest('wisp.pong', { provides: { 'pong.service': { version: '1.0.0' } }, contributes: { points: [{ id: 'pong.list', version: 1, kind: 'list' }] } }), {
    def: def('wisp.pong', (ctx) => ctx.provide(ref, { ping: () => 'pong' })),
  });
  let lost = '';
  let ctxRef: PluginContext | undefined;
  const m = manifest('wisp.leaky', {
    requires: { 'pong.service': { version: '^1', optional: true } },
    permissions: ['pong:ping'],
    contributes: { commands: [{ id: 'leaky.go', title: 'Go' }], settings: [{ key: 'leaky.n', type: 'int', default: 1 }], 'pong.list': [{ static: true }] },
  });
  k.register(m, {
    def: def('wisp.leaky', (ctx) => {
      ctxRef = ctx;
      ctx.command({ id: 'leaky.go', run: () => 1 });
      ctx.intercept({ hook: 'before:run', run: () => ({ kind: 'continue' }) });
      ctx.on('pong.*', () => undefined);
      ctx.contribute('pong.list', { dynamic: true });
      ctx.settings.watch('leaky.n', () => undefined);
      ctx.scope.interval(1, () => ticks++);
      ctx.scope.timeout(10_000, () => undefined);
      const p = ctx.tryUse(ref, { onLost: (why) => (lost = why) });
      assert.equal(p?.ping(), 'pong');
    }),
  });
  await k.start();
  const before = k.inspect('wisp.leaky');
  assert.ok(before.commands === 1 && before.interceptors === 1 && before.subscriptions === 1 && before.handles === 1 && before.contributions === 2 && before.scope > 5, JSON.stringify(before));
  await k.deactivate('wisp.leaky');
  assert.deepEqual(k.inspect('wisp.leaky'), { scope: 0, commands: 0, interceptors: 0, subscriptions: 0, provided: 0, handles: 0, contributions: 0, queued: 0 });
  assert.equal(k.settings.watcherCount, 0);
  assert.equal(k.settings.info('leaky.n'), undefined);
  const t = ticks;
  await sleep(10);
  assert.equal(ticks, t, 'its interval stopped');
  assert.equal(lost, '', 'onLost is for the provider going, not the consumer');
  assert.throws(() => ctxRef?.command({ id: 'leaky.go', run: () => 1 }), /wisp\.leaky is off/);
  assert.equal(ctxRef?.scope.alive, false);
  // the provider going off: the provider leaks nothing either
  await k.deactivate('wisp.pong');
  assert.equal(k.inspect('wisp.pong').provided, 0);
});

test('extensions: live ones, minus disabled ids, overrides by id and priority', async () => {
  const k = new Kernel();
  const ui = (id: string, priority?: number) => ({ id, attachTo: { id: 'shell.composer', input: 'left' }, kit: { c: 'Button' }, ...(priority !== undefined && { priority }) });
  k.register(manifest('wisp.shell', { contributes: { ui: [ui('shell.send'), ui('shell.mic')] } }));
  k.register(manifest('user.mine', { disable: ['shell.mic'], contributes: { ui: [ui('mine.extra')] } }));
  k.register(manifest('user.over', { contributes: { ui: [ui('over.x', 1)] } }));
  k.register(manifest('user.under', { contributes: { ui: [ui('over.x', 0)] } }));
  await k.start();
  const ids = k.extensions().map((x) => `${x.id}@${x.plugin}`);
  assert.deepEqual(ids, ['shell.send@wisp.shell', 'mine.extra@user.mine', 'over.x@user.over']);
  await k.deactivate('user.mine');
  assert.ok(k.extensions().some((x) => x.id === 'shell.mic'));
});

test('stop switches everything off', async () => {
  const k = new Kernel();
  k.register(manifest('a.one'), { def: def('a.one', () => undefined) });
  await k.start();
  k.stop();
  assert.equal(k.status()[0]?.state, 'off');
  assert.equal((await rejection(k.run('one.x', {}, user))).code, 'not_found');
});
