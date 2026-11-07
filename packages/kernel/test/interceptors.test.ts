// Interceptors (plan §6.1b, §6.11.2 rules 3–5): ordered by priority, continue/modify/veto, a time
// budget per hook, guards fail closed, others fail open, read-only inside, `then` after.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel, type EventEnvelope, type InterceptorDef, type KernelOptions, type PluginContext } from '../src/index.ts';
import { def, manifest, rejection, rng, sleep } from './helpers.ts';

const user = { set: 'user:full' } as const;

/** wisp.host owns `host.go`, which runs the `before:go` hook and returns what came out of it. */
async function setup(guards: Record<string, InterceptorDef<{ n: number }>[]>, o: KernelOptions = {}, more?: (k: Kernel) => void): Promise<Kernel> {
  const k = new Kernel(o);
  k.register(manifest('wisp.host', { contributes: { commands: [{ id: 'host.go', title: 'Go' }, { id: 'host.read', title: 'Read' }, { id: 'host.write', title: 'Write' }, { id: 'host.notice', title: 'Notice' }] } }), {
    def: def('wisp.host', (ctx) => {
      ctx.command({ id: 'host.go', run: (args: { n: number }, call) => call.runHook('before:go', args) });
      ctx.command({ id: 'host.read', readOnly: true, run: () => 42 });
      ctx.command({ id: 'host.write', run: () => 'wrote' });
      ctx.command({ id: 'host.notice', run: (a) => void ctx.emit('host.noticed', a as { text: string }) });
    }),
  });
  for (const [id, defs] of Object.entries(guards))
    k.register(manifest(id, { permissions: ['host:read', 'host:write', 'host:notice'] }), { def: def(id, (ctx) => defs.forEach((d) => ctx.intercept(d))) });
  more?.(k);
  await k.start();
  return k;
}

test('interceptors run by priority (lower first); modify passes the new context on', async () => {
  const order: string[] = [];
  const step = (name: string, priority: number, add: number): InterceptorDef<{ n: number }> => ({
    hook: 'before:go',
    priority,
    run: (c) => (order.push(name), { kind: 'modify', ctx: { n: c.n + add } }),
  });
  const k = await setup({ 'p.late': [step('late', 10, 100)], 'p.early': [step('early', -5, 1)], 'p.mid': [step('mid', 0, 10), { hook: 'other', run: () => ({ kind: 'veto', code: 'x', message: 'never' }) }] });
  assert.deepEqual(await k.run('host.go', { n: 0 }, user), { n: 111 });
  assert.deepEqual(order, ['early', 'mid', 'late']);
});

test('a veto stops the chain and refuses the command with its message', async () => {
  const ran: string[] = [];
  const vetoed: EventEnvelope[] = [];
  const k = await setup(
    {
      'p.first': [{ hook: 'before:go', priority: 1, run: () => (ran.push('first'), { kind: 'veto', code: 'budget_exceeded', message: 'Daily budget $20 reached ($20.40)' }) }],
      'p.second': [{ hook: 'before:go', priority: 2, run: () => (ran.push('second'), { kind: 'continue' }) }],
    },
    {},
    (k) => k.register(manifest('p.audit'), { def: def('p.audit', (ctx) => ctx.on('kernel.vetoed', (e) => void vetoed.push(e))) }),
  );
  const e = await rejection(k.run('host.go', { n: 0 }, user));
  assert.equal(e.code, 'vetoed');
  assert.equal(e.message, 'Daily budget $20 reached ($20.40)');
  assert.deepEqual(e.details, { by: 'p.first', reason: 'budget_exceeded', hook: 'before:go' });
  assert.deepEqual(ran, ['first']);
  await k.idle();
  assert.equal((vetoed[0]?.data as { by: string }).by, 'p.first');
  assert.equal(vetoed[0]?.plugin, 'wisp.kernel');
});

test('timeouts: a guard (failure closed) vetoes, anything else is skipped with a warning', async () => {
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} };
  const slow = (failure: 'open' | 'closed', timeoutMs?: number): InterceptorDef<{ n: number }> => ({ hook: 'before:go', failure, ...(timeoutMs && { timeoutMs }), run: () => sleep(60).then(() => ({ kind: 'continue' as const })) });
  const open = await setup({ 'p.slow': [slow('open', 10)] }, { log });
  assert.deepEqual(await open.run('host.go', { n: 1 }, user), { n: 1 });
  assert.match(warnings.join('\n'), /p\.slow didn't answer before:go within 10 ms; skipped \(failure open\)/);
  const closed = await setup({ 'p.guard': [slow('closed', 10)] });
  const e = await rejection(closed.run('host.go', { n: 1 }, user));
  assert.equal(e.code, 'vetoed');
  assert.equal(e.message, "p.guard didn't answer before:go within 10 ms");
  assert.equal((e.details as { reason: string }).reason, 'timeout');
  assert.equal(closed.diagnostics.failures('p.guard')[0]?.code, 'timeout');
});

test('the time budget is 200 ms by default and at most 2000 ms', async () => {
  const started = Date.now();
  const k = await setup({ 'p.guard': [{ hook: 'before:go', failure: 'closed', run: () => new Promise(() => undefined) }] });
  await rejection(k.run('host.go', { n: 1 }, user));
  const took = Date.now() - started;
  assert.ok(took >= 190 && took < 1500, `took ${took} ms`);
  const capped = await setup({ 'p.guard': [{ hook: 'before:go', failure: 'closed', timeoutMs: 60_000, run: () => new Promise(() => undefined) }] }, { timers: { setTimeout: (fn, ms) => (assert.ok(ms <= 2000, `asked for ${ms}`), setTimeout(fn, 1)), clearTimeout: (h) => clearTimeout(h as never), setInterval, clearInterval: (h) => clearInterval(h as never) } });
  await rejection(capped.run('host.go', { n: 1 }, user));
});

test('a throwing or confused interceptor: closed vetoes, open skips', async () => {
  const k = await setup({
    'p.throws': [{ hook: 'before:go', run: () => Promise.reject(new Error('oops')) }],
    'p.junk': [{ hook: 'before:go', run: () => ({ kind: 'maybe' }) as never }, { hook: 'before:go', run: () => ({ kind: 'veto' }) as never }, { hook: 'before:go', run: () => ({ kind: 'modify' }) as never }],
  });
  assert.deepEqual(await k.run('host.go', { n: 2 }, user), { n: 2 });
  assert.equal(k.diagnostics.failures('p.junk').length, 3);
  const g = await setup({ 'p.throws': [{ hook: 'before:go', failure: 'closed', run: () => Promise.reject(new Error('oops')) }] });
  const e = await rejection(g.run('host.go', { n: 2 }, user));
  assert.equal(e.message, 'p.throws failed on before:go: oops');
});

test('interceptors read and decide: a read-only command works, a write is refused', async () => {
  let readResult: unknown;
  let writeError: { code?: string; message?: string } = {};
  const k = await setup({
    'p.reader': [
      {
        hook: 'before:go',
        run: async (c, call) => {
          assert.equal(call.trace.readOnly, true);
          readResult = await call.run('host.read');
          writeError = await call.run('host.write').then(
            () => ({}),
            (e: { code: string; message: string }) => e,
          );
          return { kind: 'continue' };
        },
      },
    ],
  });
  await k.run('host.go', { n: 0 }, user);
  assert.equal(readResult, 42);
  assert.equal(writeError.code, 'forbidden');
  assert.equal(writeError.message, 'host.write writes, and an interceptor may only read');
});

test('`then` follow-ups run after the vetoed command, as new root commands speaking for the interceptor', async () => {
  const noticed: EventEnvelope[] = [];
  const k = await setup(
    { 'p.budget': [{ hook: 'before:go', failure: 'closed', run: () => ({ kind: 'veto', code: 'over', message: 'no', then: [{ cmd: 'host.notice', args: { text: 'over budget' } }, { cmd: 'host.nope', args: {} }] }) }] },
    {},
    (k) => k.register(manifest('p.ear'), { def: def('p.ear', (ctx) => ctx.on('host.noticed', (e) => void noticed.push(e))) }),
  );
  await rejection(k.run('host.go', { n: 0 }, user));
  await k.idle();
  assert.deepEqual(noticed.map((e) => e.data), [{ text: 'over budget' }]);
  // the failing follow-up was logged, not thrown at anyone
  assert.equal(k.diagnostics.refusals().at(-1)?.code, 'not_found');
});

test('an interceptor that would cause its own hook again is refused: reentrant_hook', async () => {
  const errors: string[] = [];
  const k = new Kernel();
  k.register(manifest('wisp.runtime', { contributes: { commands: [{ id: 'runtime.start', title: 'Start' }, { id: 'runtime.peek', title: 'Peek' }] } }), {
    def: def('wisp.runtime', (ctx) => {
      ctx.command({ id: 'runtime.start', run: (a, call) => call.runHook('before:run', a) });
      // a read that (wrongly) runs the hook again
      ctx.command({ id: 'runtime.peek', readOnly: true, run: (a, call) => call.runHook('before:run', a) });
    }),
  });
  k.register(manifest('wisp.budget', { permissions: ['runtime:peek'] }), {
    def: def('wisp.budget', (ctx: PluginContext) =>
      ctx.intercept({
        hook: 'before:run',
        failure: 'closed',
        run: async (c, call) => {
          await call.run('runtime.peek', c).catch((e: Error & { code: string }) => errors.push(`${e.code}: ${e.message}`));
          return { kind: 'continue' };
        },
      }),
    ),
  });
  await k.start();
  await k.run('runtime.start', {}, user);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /^reentrant_hook: before:run would run wisp\.budget's interceptor again inside itself \(wisp\.runtime:runtime\.start → wisp\.budget:before:run → wisp\.runtime:runtime\.peek → wisp\.budget:before:run\)/);
});

test('testkit hooks: a random order of equal priorities and injected slowness keep the result', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const order: string[] = [];
    const mk = (name: string): InterceptorDef<{ n: number }> => ({ hook: 'before:go', failure: 'closed', timeoutMs: 100, run: (c) => (order.push(name), { kind: 'modify', ctx: { n: c.n + 1 } }) });
    const k = await setup({ 'p.a': [mk('a')], 'p.b': [mk('b')], 'p.c': [mk('c')] }, { testHooks: { random: r, interceptorDelay: () => Math.floor(r() * 20) } });
    assert.deepEqual(await k.run('host.go', { n: 0 }, user), { n: 3 }, `seed ${seed}`);
    assert.equal(new Set(order).size, 3);
  }
});

test('an interceptor of a plugin that went off no longer runs', async () => {
  const k = await setup({ 'p.v': [{ hook: 'before:go', run: () => ({ kind: 'veto', code: 'no', message: 'no' }) }] });
  await rejection(k.run('host.go', { n: 0 }, user));
  await k.deactivate('p.v');
  assert.deepEqual(await k.run('host.go', { n: 0 }, user), { n: 0 });
});
