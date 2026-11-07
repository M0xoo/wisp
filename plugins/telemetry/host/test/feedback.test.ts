// POST /api/feedback and /api/telemetry/event (v1 test/feedback.test.js, the route half).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigPart } from '@wisp-plugin/settings-api';
import { sent, start, withEnv } from './fixture.ts';
import { settle } from './harness.ts';

const ON = { WISP_FEEDBACK: '1', WISP_POSTHOG_KEY: undefined };

test('/api/feedback: thumbs stick to the turn and carry the run, not the prompt', async () => {
  const f = await start();
  const r = await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: 'down', sessionId: 's1', turnId: 't1', source: 'turn' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, sent: true, available: true });
  assert.equal((f.sessions.get('s1')?.turns[1]?.ext['wisp.telemetry'] as { feedback: { rating: string } }).feedback.rating, 'down');
  const ev = sent(f).at(-1);
  assert.equal(ev?.event, 'turn_rated');
  assert.equal(ev?.properties['rating'], 'down');
  assert.equal(ev?.properties['agent'], 'wisp');
  assert.equal(ev?.properties['tour'], true);
  assert.equal(ev?.properties['followUp'], true);
  assert.deepEqual(ev?.properties['blockTypes'], ['hero', 'text']);
  assert.equal(ev?.properties['heroStatus'], 'done');
  assert.equal(ev?.properties['durationMs'], 3000);
  assert.ok(!JSON.stringify(ev).includes('payroll'), 'the prompt never leaves');
  assert.deepEqual(f.host.emitted.at(-1), { type: 'telemetry.rated', data: { sessionId: 's1', turnId: 't1', rating: 'down' } }, 'wisp.router counts it');

  // A note after 👎 is a 'feedback' event; clicking the thumb again takes the rating back.
  await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: 'down', text: 'diff was empty', sessionId: 's1', turnId: 't1' }));
  assert.equal(sent(f).at(-1)?.event, 'feedback');
  assert.equal(sent(f).at(-1)?.properties['text'], 'diff was empty');
  await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: null, sessionId: 's1', turnId: 't1' }));
  assert.equal(sent(f).at(-1)?.event, 'turn_rated');
  assert.equal(sent(f).at(-1)?.properties['cleared'], true);
  assert.equal(f.sessions.get('s1')?.turns[1]?.ext['wisp.telemetry'], undefined);
});

test('/api/feedback: /feedback text and the dialog rating stay off the turn', async () => {
  const f = await start();
  await withEnv(ON, () => f.host.call('POST', '/api/feedback', { text: 'love it', rating: 'up', sessionId: 's1', source: 'dialog' }));
  assert.equal(sent(f).at(-1)?.event, 'feedback');
  assert.equal(sent(f).at(-1)?.properties['source'], 'dialog');
  assert.equal(sent(f).at(-1)?.properties['rating'], 'up');
  assert.ok(f.sessions.get('s1')?.turns.every((t) => t.ext['wisp.telemetry'] === undefined));
  assert.ok(!f.host.ran.some((r) => r.cmd === 'runtime.turn.setExt'));
});

test('/api/feedback: a bug report goes out as feedback with kind bug, and needs words', async () => {
  const f = await start();
  await withEnv(ON, () => f.host.call('POST', '/api/feedback', { kind: 'bug', text: 'the list jumps when a task opens', source: 'home' }));
  assert.equal(sent(f).at(-1)?.event, 'feedback');
  assert.equal(sent(f).at(-1)?.properties['kind'], 'bug');
  assert.equal(sent(f).at(-1)?.properties['source'], 'home');
  assert.equal((await f.host.call('POST', '/api/feedback', { kind: 'bug' })).status, 400);
  assert.equal((await f.host.call('POST', '/api/feedback', { kind: 'bug', rating: 'down' })).status, 400, 'thumbs alone are no bug report');
  assert.equal((await f.host.call('POST', '/api/feedback', { kind: 'rant', text: 'x' })).status, 400);
});

test('/api/feedback: refuses empty notes and bad ratings; reports when feedback is off', async () => {
  const f = await start();
  await withEnv({ WISP_FEEDBACK: '0' }, async () => {
    assert.equal((await f.host.call('POST', '/api/feedback', {})).status, 400);
    assert.match(String((await f.host.call('POST', '/api/feedback', {})).json['error']), /Write something/);
    assert.equal((await f.host.call('POST', '/api/feedback', { rating: 'meh' })).status, 400);
    assert.equal((await f.host.call('POST', '/api/feedback', { text: 'x', sessionId: 'nope' })).status, 404);
    assert.equal((await f.host.call('POST', '/api/feedback', { text: 'x', sessionId: 's1', turnId: 'nope' })).status, 404);
    assert.deepEqual((await f.host.call('POST', '/api/feedback', { text: 'hello' })).json, { ok: true, sent: false, available: false });
    const part = f.host.contributed.get('settings.config')?.[0] as ConfigPart;
    assert.equal((await part.read())['feedback'], false, 'GET /api/config says so');
  });
});

test('/api/feedback: a task on another machine is rated there; offline, it goes from here without the run', async () => {
  let up = true;
  const f = await start({ peer: () => (up ? { ok: true, sent: true, available: true } : Promise.reject(Object.assign(new Error('offline'), { status: 502 }))) });
  const r = await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: 'up', sessionId: 'abc@m1', turnId: 't9' }));
  assert.deepEqual(r.json, { ok: true, sent: true, available: true });
  assert.deepEqual(f.peerCalls[0], { machine: 'm1', method: 'POST', path: '/feedback', body: { text: '', rating: 'up', sessionId: 'abc', turnId: 't9' } });
  assert.equal(sent(f).length, 0, 'that wisp sends it');
  up = false;
  const r2 = await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: 'up', sessionId: 'abc@m1', turnId: 't9' }));
  assert.equal(r2.json['sent'], true);
  assert.equal(sent(f).at(-1)?.properties['machine'], true);
  assert.equal(sent(f).at(-1)?.properties['agent'], undefined, 'without the run');
});

test('/api/feedback: a refusal from the other machine is the answer here', async () => {
  const f = await start({ peer: () => Promise.reject(Object.assign(new Error('no such turn'), { status: 400 })) });
  const r = await withEnv(ON, () => f.host.call('POST', '/api/feedback', { rating: 'up', sessionId: 'abc@m1', turnId: 't9' }));
  assert.equal(r.status, 400);
  assert.equal(sent(f).length, 0);
});

test('page events: the route takes them, and says nothing went out while usage stats are off', async () => {
  const f = await start();
  await withEnv({ WISP_TELEMETRY: '0' }, async () => {
    assert.deepEqual((await f.host.call('POST', '/api/telemetry/event', { event: 'getapp_hidden' })).json, { ok: true, tracked: false });
    assert.deepEqual((await f.host.call('POST', '/api/telemetry/event', { event: 'nope' })).json, { ok: true, tracked: false });
  });
  await f.host.clock.advance(15_000);
  await settle();
  assert.equal(sent(f).filter((e) => e.event === 'getapp_hidden').length, 0);
});

test('page events with stats on: counted with only the allowed props', async () => {
  const f = await start();
  await withEnv({ WISP_TELEMETRY: '1', DO_NOT_TRACK: undefined, CI: undefined }, async () => {
    assert.deepEqual((await f.host.call('POST', '/api/telemetry/event', { event: 'getapp_opened', props: { from: 'search', email: 'a@b.c' } })).json, { ok: true, tracked: true });
    await f.host.clock.advance(15_000);
    await settle();
  });
  const ev = sent(f).find((e) => e.event === 'getapp_opened');
  assert.equal(ev?.properties['from'], 'search');
  assert.equal(ev?.properties['email'], undefined);
});
