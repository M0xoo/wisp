// Commands (plan §6.5, §6.11.2): permission at the boundary, traces with depth and re-entry limits,
// read-only inside interceptors, WireErrors out, events after the transaction commits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel, MAX_DEPTH, toWireError, type CallContext, type EventEnvelope, type Manifest, type PluginContext } from '../src/index.ts';
import { def, manifest, rejection } from './helpers.ts';

const user = { set: 'user:full' } as const;
const cmds = (...ids: string[]): Partial<Manifest> => ({ contributes: { commands: ids.map((id) => ({ id, title: id })) } });

async function kernelWith(setup: (ctx: PluginContext) => void, extra: Partial<Manifest> = {}, o: ConstructorParameters<typeof Kernel>[0] = {}): Promise<Kernel> {
  const k = new Kernel(o);
  k.register(manifest('wisp.test', { ...cmds('test.a', 'test.b', 'test.read', 'test.loop', 'test.emit', 'test.fail', 'test.parse'), ...extra }), { def: def('wisp.test', setup) });
  await k.start();
  return k;
}

test('a missing permission is refused, with the set and the permission named', async () => {
  const k = await kernelWith((ctx) => ctx.command({ id: 'test.a', run: () => 'ran' }));
  assert.equal(await k.run('test.a', {}, user), 'ran');
  const e = await rejection(k.run('test.a', {}, { set: 'preview' }));
  assert.equal(e.code, 'forbidden');
  assert.equal(e.message, 'test.a refused: preview may not test:a');
  assert.equal((await rejection(k.run('test.a', {}, { set: 'who' }))).message, 'test.a refused: who is not a capability set');
  assert.equal((await rejection(k.run('test.a', {}, { set: 'plugin' }))).message, 'test.a refused: a plugin caller names its plugin');
  assert.equal((await rejection(k.run('test.a', {}, undefined as never))).message, 'test.a refused: a call from the edge names who it speaks for');
  assert.equal(k.diagnostics.refusals().length, 4);
  assert.deepEqual(k.diagnostics.refusals()[0]?.stack, ['wisp.test:test.a']);
});

test('a named permission and a scoped capability set', async () => {
  const k = await kernelWith((ctx) => ctx.command({ id: 'test.a', permission: 'runtime:start{project:other}', run: () => 'ran' }));
  assert.match((await rejection(k.run('test.a', {}, { set: 'agent:capped' }))).message, /can't start a task in another project/);
  assert.equal(await k.run('test.a', {}, { set: 'agent:session' }), 'ran');
});

test('a plugin calling another plugin needs that permission in its manifest', async () => {
  const k = new Kernel();
  k.register(manifest('wisp.runtime', cmds('runtime.start')), { def: def('wisp.runtime', (ctx) => ctx.command({ id: 'runtime.start', run: (_a, call) => call.trace.caller.set })) });
  let allowedCtx: PluginContext | undefined;
  let deniedCtx: PluginContext | undefined;
  k.register(manifest('wisp.channels', { permissions: ['runtime:start'] }), { def: def('wisp.channels', (ctx) => void (allowedCtx = ctx)) });
  k.register(manifest('wisp.rogue'), { def: def('wisp.rogue', (ctx) => void (deniedCtx = ctx)) });
  await k.start();
  assert.equal(await allowedCtx?.run('runtime.start'), 'plugin');
  // speaking for someone else only narrows: both must allow it
  assert.equal(await allowedCtx?.run('runtime.start', {}, { caller: { set: 'agent:session' } }), 'agent:session');
  assert.match((await rejection(allowedCtx?.run('runtime.start', {}, { caller: { set: 'preview' } }) ?? Promise.resolve())).message, /preview may not runtime:start/);
  assert.equal((await rejection(deniedCtx?.run('runtime.start') ?? Promise.resolve())).message, 'runtime.start refused: plugin:wisp.rogue may not runtime:start');
});

test('commands must be declared, owner-prefixed and unique', async () => {
  const k = new Kernel();
  const errs: string[] = [];
  const tryIt = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errs.push((e as Error).message);
    }
  };
  k.register(manifest('wisp.a', cmds('a.one')), {
    def: def('wisp.a', (ctx) => {
      tryIt(() => ctx.command({ id: 'a.undeclared', run: () => 1 }));
      tryIt(() => ctx.command({ id: 'b.one', run: () => 1 }));
      ctx.command({ id: 'a.one', run: () => 1 });
    }),
  });
  // acme.a has the same prefix as wisp.a: the second to register a.one is refused
  k.register(manifest('acme.a', cmds('a.one')), { def: def('acme.a', (ctx) => tryIt(() => ctx.command({ id: 'a.one', run: () => 1 }))) });
  await k.start();
  assert.deepEqual(errs, [
    "wisp.a registers a.undeclared, which isn't in its manifest's contributes.commands",
    "wisp.a can't register b.one: command ids start with its prefix",
    'a.one is already registered by wisp.a',
  ]);
});

test('unknown commands and commands of a plugin that is off', async () => {
  const k = await kernelWith((ctx) => ctx.command({ id: 'test.a', run: () => 1 }));
  const e = await rejection(k.run('nope.x', {}, user));
  assert.equal(e.code, 'not_found');
  assert.match(e.message, /unknown command nope\.x/);
  await k.deactivate('wisp.test');
  assert.equal((await rejection(k.run('test.a', {}, user))).code, 'not_found');
});

test('errors cross as WireErrors; parse failures are invalid', async () => {
  const k = await kernelWith((ctx) => {
    ctx.command({
      id: 'test.fail',
      run: () => {
        throw new Error('disk full');
      },
    });
    ctx.command({
      id: 'test.b',
      run: () => {
        throw { code: 'conflict', message: 'taken', retry: true };
      },
    });
    ctx.command({
      id: 'test.parse',
      parse: (a) => {
        if (typeof a !== 'string') throw new Error('want a string');
        return a;
      },
      run: (a: string) => a.length,
    });
  });
  const fail = await rejection(k.run('test.fail', {}, user));
  assert.deepEqual(toWireError(fail), { code: 'internal', message: 'disk full', retry: false });
  assert.deepEqual(toWireError(await rejection(k.run('test.b', {}, user))), { code: 'conflict', message: 'taken', retry: true });
  assert.deepEqual(toWireError(await rejection(k.run('test.parse', 3, user))), { code: 'invalid', message: 'test.parse: want a string', retry: false });
  assert.equal(await k.run('test.parse', 'abc', user), 3);
  assert.deepEqual(toWireError('plain'), { code: 'internal', message: 'plain', retry: false });
  assert.equal(k.diagnostics.failures('wisp.test').length, 3);
});

test(`calls nest at most ${MAX_DEPTH} deep: depth_exceeded with the trace`, async () => {
  const k = new Kernel();
  const depths: number[] = [];
  // a chain of distinct commands, so only depth stops it (not re-entry)
  const ids = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `chain.c${i}`);
  k.register(manifest('wisp.chain', cmds(...ids)), {
    def: def('wisp.chain', (ctx) => {
      ids.forEach((id, i) =>
        ctx.command({
          id,
          run: async (_a, call) => {
            depths.push(call.trace.depth);
            const next = ids[i + 1];
            return next ? call.run(next) : 'bottom';
          },
        }),
      );
    }),
  });
  await k.start();
  const e = await rejection(k.run('chain.c0', {}, user));
  assert.equal(e.code, 'depth_exceeded');
  assert.match(e.message, /chain\.c8 would run at depth 8: calls nest at most 8 deep \(wisp\.chain:chain\.c0 → .* → wisp\.chain:chain\.c8\)/);
  assert.deepEqual(depths, [0, 1, 2, 3, 4, 5, 6, 7]);
  const r = k.diagnostics.refusals().at(-1);
  assert.equal(r?.code, 'depth_exceeded');
  assert.equal(r?.stack?.length, 9);
});

test('a command can not re-enter itself in the same trace: reentrant_hook', async () => {
  let viaSetupCtx: PluginContext | undefined;
  const k = await kernelWith((ctx) => {
    viaSetupCtx = ctx;
    ctx.command({ id: 'test.loop', run: (_a, call: CallContext) => call.run('test.b') });
    // the setup ctx inside a handler still joins the trace (AsyncLocalStorage): no escaping the rule
    ctx.command({ id: 'test.b', run: () => viaSetupCtx?.run('test.loop') });
  });
  const e = await rejection(k.run('test.loop', {}, user));
  assert.equal(e.code, 'reentrant_hook');
  assert.equal(e.message, 'test.loop is already running in this call (wisp.test:test.loop → wisp.test:test.b → wisp.test:test.loop)');
});

test('a trace carries root, depth, stack, caller and an abort signal', async () => {
  const seen: CallContext['trace'][] = [];
  const k = await kernelWith((ctx) => {
    ctx.command({ id: 'test.a', run: (_a, call) => (seen.push(call.trace), call.run('test.b')) });
    ctx.command({ id: 'test.b', run: (_a, call) => void seen.push(call.trace) });
  });
  await k.run('test.a', {}, { set: 'user:full', session: 's1' });
  const [a, b] = seen;
  assert.ok(a && b);
  assert.equal(a.root, b.root);
  assert.match(a.root, /^[0-9a-f-]{36}$/);
  assert.equal(b.depth, 1);
  assert.deepEqual(b.stack, ['wisp.test:test.a', 'wisp.test:test.b']);
  assert.deepEqual(b.caller, { set: 'user:full', session: 's1' });
  assert.equal(a.signal.aborted, true, 'the call is over');
});

test('events emitted in a command go out after its transaction commits, and not at all when it fails', async () => {
  const log: string[] = [];
  const transaction = async <R>(fn: () => Promise<R>): Promise<R> => {
    log.push('begin');
    try {
      const r = await fn();
      log.push('commit');
      return r;
    } catch (e) {
      log.push('rollback');
      throw e;
    }
  };
  const got: EventEnvelope[] = [];
  const k = new Kernel({ transaction });
  k.register(manifest('wisp.test', { ...cmds('test.emit', 'test.fail', 'test.nested') }), {
    def: def('wisp.test', (ctx) => {
      ctx.command({ id: 'test.emit', run: (_a, call) => (ctx.emit('test.happened', { n: 1 }), log.push('emitted'), call.run('test.nested')) });
      ctx.command({ id: 'test.nested', run: () => void ctx.emit('test.nested', { n: 2 }) });
      ctx.command({
        id: 'test.fail',
        run: () => {
          ctx.emit('test.happened', { n: 3 });
          throw new Error('no');
        },
      });
    }),
  });
  k.register(manifest('wisp.listen'), {
    def: def('wisp.listen', (ctx) =>
      ctx.on('test.*', (e) => {
        log.push(`heard ${e.type}`);
        got.push(e);
      }),
    ),
  });
  await k.start();
  await k.run('test.emit', {}, user);
  await k.idle();
  assert.deepEqual(log, ['begin', 'emitted', 'commit', 'heard test.happened', 'heard test.nested']);
  assert.ok((got[0]?.seq ?? 0) < (got[1]?.seq ?? 0));
  assert.equal(got[0]?.plugin, 'wisp.test');
  log.length = 0;
  await rejection(k.run('test.fail', {}, user));
  await k.idle();
  assert.deepEqual(log, ['begin', 'rollback']);
});

test('a plugin announces only its own events, as plain JSON; outside a command they go out at once', async () => {
  let c: PluginContext | undefined;
  const k = await kernelWith((ctx) => void (c = ctx));
  assert.throws(() => c?.emit('runtime.started', {}), /a plugin announces its own events/);
  assert.throws(() => c?.emit('test.x', new Date() as never), /plain JSON/);
  const heard: string[] = [];
  k.events.tap((e) => heard.push(e.type));
  c?.emit('test.now', { ok: true });
  assert.deepEqual(heard, ['test.now']);
});
