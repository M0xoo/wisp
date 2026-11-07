// Plan §6.11.3, end to end with fake plugins: a Slack message starts a task and the budget refuses it.
// slack knows nothing about budgets, budget nothing about Slack, runtime neither; the refusal goes
// back through the channel it came in on, with no direct call between any two of them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineService, Kernel, type Json, type PluginContext } from '../src/index.ts';
import { def, manifest } from './helpers.ts';

interface BudgetService {
  day(): { spent: number; limit: number };
}
const budgetService = defineService<BudgetService>('budget.service', 1, { day: 'budget:read' }, ['day']);

interface World {
  k: Kernel;
  outbound: string[];
  spawned: string[];
  sessions: Map<string, Json>;
  heard: string[];
  inbound(text: string): Promise<unknown>;
}

async function world(spent: number, budgetOn = true): Promise<World> {
  const outbound: string[] = [];
  const spawned: string[] = [];
  const sessions = new Map<string, Json>();
  const heard: string[] = [];
  const k = new Kernel({ transaction: async (fn) => fn() });
  let slack: PluginContext | undefined;

  // runtime: sessions and runs; it runs before:run and spawns only when nobody refuses
  k.register(manifest('wisp.runtime', { contributes: { commands: [{ id: 'runtime.create', title: 'New task' }, { id: 'runtime.start', title: 'Start' }], events: ['runtime.created', 'runtime.refused'] } }), {
    builtin: true,
    def: def('wisp.runtime', (ctx) => {
      ctx.command({
        id: 'runtime.create',
        run: (a: { prompt: string; capped?: { mode: string }; origin: Json }) => {
          const id = `s${sessions.size + 1}`;
          sessions.set(id, { id, prompt: a.prompt, state: 'new', origin: a.origin });
          ctx.emit('runtime.created', { id });
          return id;
        },
      });
      ctx.command({
        id: 'runtime.start',
        run: async (a: { session: string }, call) => {
          const s = sessions.get(a.session) as { state: string; origin: Json };
          try {
            await call.runHook('before:run', { session: a.session, origin: s.origin });
          } catch (e) {
            s.state = `refused: ${(e as { details: { by: string } }).details.by.split('.')[1]}`;
            throw e;
          }
          spawned.push(a.session);
          s.state = 'running';
          return 'started';
        },
      });
    }),
  });

  // channels: who may speak, then create + start; delivers notices back to the origin's transport
  k.register(manifest('wisp.channels', { permissions: ['runtime:create', 'runtime:start'], contributes: { commands: [{ id: 'channels.inbound', title: 'Inbound' }, { id: 'channels.start', title: 'Start' }, { id: 'channels.notice', title: 'Notice' }], events: ['channels.noticed'], points: [{ id: 'channels.transport', version: 1, kind: 'list' }] } }), {
    builtin: true,
    def: def('wisp.channels', (ctx) => {
      ctx.command({
        id: 'channels.inbound',
        run: async (a: { transport: string; from: string; text: string }, call) => {
          if (a.from !== 'U-owner') throw { code: 'forbidden', message: 'not allowed to start tasks here' };
          const origin = { transport: a.transport, channel: '#dev' };
          return call.run<string>('runtime.create', { prompt: a.text, capped: { mode: 'edits' }, origin });
        },
      });
      // a second root command: the session above committed (tx 1) before this one runs
      ctx.command({ id: 'channels.start', run: (a: { session: string }, call) => call.run('runtime.start', a) });
      ctx.command({ id: 'channels.notice', run: (a: { to: Json; text: string }) => void ctx.emit('channels.noticed', a) });
    }),
  });

  // slack: a module of channels; inbound messages in, `channels.noticed` out
  k.register(manifest('wisp.slack', { kind: 'module', extends: 'wisp.channels', permissions: ['channels:inbound', 'channels:start'], contributes: { 'channels.transport': [{ id: 'slack' }] } }), {
    builtin: true,
    def: def('wisp.slack', (ctx) => {
      slack = ctx;
      ctx.on('channels.noticed', (e) => {
        const d = e.data as { to: { transport: string }; text: string };
        if (d.to.transport === 'slack') outbound.push(d.text);
      });
    }),
  });

  // capped and side-gate: guards that let this one through
  for (const id of ['wisp.capped', 'wisp.sidegate'])
    k.register(manifest(id), { builtin: true, def: def(id, (ctx) => ctx.intercept({ hook: 'before:run', priority: id === 'wisp.capped' ? 0 : 1, failure: 'closed', run: () => ({ kind: 'continue' }) })) });

  // budget: a read-only service and a guard that vetoes over the limit, with a notice as `then`
  k.register(manifest('wisp.budget', { provides: { 'budget.service': { version: '1.0.0' } }, requires: { 'budget.service': '^1' }, permissions: ['budget:read', 'channels:notice'] }), {
    builtin: true,
    enabled: budgetOn,
    def: def('wisp.budget', (ctx) => {
      ctx.provide(budgetService, { day: () => ({ spent, limit: 20 }) });
      const budget = ctx.use(budgetService);
      ctx.intercept<{ origin: Json }>({
        hook: 'before:run',
        priority: 2,
        failure: 'closed',
        run: (c) => {
          const d = budget.day(); // a read-only method: allowed inside an interceptor
          if (d.spent < d.limit) return { kind: 'continue' };
          const text = `Daily budget reached: $${d.spent.toFixed(2)} of $${d.limit}. Raise it in Settings → Budget.`;
          return { kind: 'veto', code: 'budget_exceeded', message: `Daily budget $${d.limit} reached ($${d.spent.toFixed(2)})`, then: [{ cmd: 'channels.notice', args: { to: c.origin, text } }] };
        },
      });
    }),
  });
  k.register(manifest('wisp.list'), { def: def('wisp.list', (ctx) => ctx.on('*', (e) => void heard.push(e.type))) });
  await k.start();
  const inbound = async (text: string) => {
    const s = slack ?? assert.fail();
    const session = await s.run<string>('channels.inbound', { transport: 'slack', from: 'U-owner', text });
    return s.run('channels.start', { session });
  };
  return { k, outbound, spawned, sessions, heard, inbound };
}

test('§6.11.3: the budget refuses the run, nothing spawns, and Slack hears why', async () => {
  const w = await world(20.4);
  const err = await w.inbound('@wisp fix the flaky login test').then(
    () => assert.fail('should be refused'),
    (e: { code: string; message: string; details: unknown }) => e,
  );
  assert.equal(err.code, 'vetoed');
  assert.equal(err.message, 'Daily budget $20 reached ($20.40)');
  assert.deepEqual(err.details, { by: 'wisp.budget', reason: 'budget_exceeded', hook: 'before:run' });
  assert.deepEqual(w.spawned, [], 'no harness spawned');
  await w.k.idle();
  assert.deepEqual(w.outbound, ['Daily budget reached: $20.40 of $20. Raise it in Settings → Budget.']);
  assert.equal((w.sessions.get('s1') as { state: string }).state, 'refused: budget');
  // the list sees the new session (tx 1 committed) and the veto; runtime.start wrote nothing
  assert.deepEqual(w.heard, ['runtime.created', 'kernel.vetoed', 'channels.noticed']);
  // the trace of the refusal is in diagnostics
  assert.equal(w.k.diagnostics.failures('wisp.runtime').at(-1)?.code, 'vetoed');
});

test('§6.11.3: under the limit it runs', async () => {
  const w = await world(3);
  assert.equal(await w.inbound('@wisp go'), 'started');
  assert.deepEqual(w.spawned, ['s1']);
  await w.k.idle();
  assert.deepEqual(w.outbound, []);
});

test('§6.11.3: switching budget off removes one interceptor and the task runs', async () => {
  const w = await world(99, false);
  assert.equal(await w.inbound('@wisp go'), 'started');
  await w.k.reactivate('wisp.budget');
  await assert.rejects(w.inbound('@wisp again'), /Daily budget/);
  await w.k.deactivate('wisp.budget');
  assert.equal(await w.inbound('@wisp once more'), 'started');
  assert.deepEqual(w.spawned, ['s1', 's3']);
  await w.k.idle();
  assert.equal(w.outbound.length, 1);
});

test('§6.11.3: switching channels off takes slack with it, with the reason', async () => {
  const w = await world(0);
  const gone = await w.k.deactivate('wisp.channels');
  assert.deepEqual(gone.map((g) => g.reason), ['wisp.channels was switched off', 'wisp.slack extends wisp.channels, which is off']);
});

test('§6.11.3: someone the channel policy refuses never creates anything', async () => {
  const w = await world(0);
  const slackCtx = w.k.pluginContext('wisp.slack' as never);
  await assert.rejects(slackCtx.run('channels.inbound', { transport: 'slack', from: 'U-stranger', text: 'hi' }), /not allowed to start tasks here/);
  assert.equal(w.sessions.size, 0);
});
