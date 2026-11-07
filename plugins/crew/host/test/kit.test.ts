// The test kit itself: commands, hooks, events, scopes on the fake clock, the fake runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestHost } from './kit/host.ts';
import { FakeRuntime } from './kit/runtime.ts';

test('kit: a plugin\'s interval runs on the fake clock and stops when it is switched off', async () => {
  const host = new TestHost();
  let n = 0;
  await host.load({ id: 'acme.tick', setup: (ctx) => ctx.scope.interval(1000, () => void n++) });
  await host.advance(3500);
  assert.equal(n, 3);
  host.unload('acme.tick');
  await host.advance(5000);
  assert.equal(n, 3);
  host.dispose();
});

test('kit: create runs before:create and before:run, a veto fails the turn, finish emits turn.finished', async () => {
  const host = new TestHost();
  const rt = await new FakeRuntime(host).install();
  const seen: string[] = [];
  await host.load({
    id: 'acme.guard',
    setup(ctx) {
      ctx.intercept<{ agent?: string }>({ hook: 'before:create', run: (c) => ({ kind: 'modify', ctx: c.agent === 'auto' ? { ...c, agent: 'codex' } : c }) });
      ctx.intercept<{ prompt: string }>({ hook: 'before:run', failure: 'closed', run: (c) => (c.prompt === 'no' ? { kind: 'veto', code: 'nope', message: 'refused' } : { kind: 'continue' }) });
      ctx.on<{ sessionId: string }>('turn.finished', (e) => void seen.push(e.data.sessionId));
    },
  });
  const { id } = await host.run<{ id: string }>('runtime.create', { prompt: 'hi', agent: 'auto' });
  assert.equal(rt.get(id)?.agent, 'codex');
  await rt.finish(id, { text: 'done' });
  assert.deepEqual(seen, [id]);
  await assert.rejects(host.run('runtime.create', { prompt: 'no' }), /refused/);
  assert.equal(rt.runs.at(-1)?.outcome, 'vetoed');
  host.dispose();
});
