// What turns report (v1 server/services/telemetry.js trackTurns), app_started, the service, and the
// plugin's lifecycle on the fake kernel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TelemetryService } from '@wisp-plugin/telemetry-api';
import { NOTICE } from '../src/index.ts';
import { endedProps, routeProps } from '../src/turns.ts';
import { sent, session, start, withEnv } from './fixture.ts';
import { settle } from './harness.ts';

const STATS_ON = { WISP_TELEMETRY: '1', DO_NOT_TRACK: undefined, CI: undefined, WISP_POSTHOG_KEY: undefined };

test('turn_started and turn_ended carry how the turn ran, never what it said', async () => {
  await withEnv(STATS_ON, async () => {
    const f = await start();
    await f.host.deliver('turn.started', { sessionId: 's1', turnId: 't0' });
    await f.host.deliver('turn.ended', { sessionId: 's1', turnId: 't1', status: 'done', interrupted: false });
    await f.host.clock.advance(15_000);
    const started = sent(f).find((e) => e.event === 'turn_started');
    assert.deepEqual({ ...started?.properties, distinct_id: undefined }, { ...started?.properties, agent: 'wisp', model: 'default', mode: 'auto', effort: 'default', followUp: false, attachments: 0, distinct_id: undefined });
    const ended = sent(f).find((e) => e.event === 'turn_ended')?.properties ?? {};
    assert.equal(ended['status'], 'done');
    assert.equal(ended['followUp'], true);
    assert.equal(ended['heroStatus'], 'done');
    assert.equal(ended['blockCount'], 3);
    assert.deepEqual(ended['blockTypes'], ['hero', 'text']);
    assert.equal(ended['durationMs'], 3000);
    assert.equal(ended['presentationFallback'], false);
    assert.equal(ended['changedFiles'], 0);
    assert.deepEqual([ended['inputTokens'], ended['outputTokens'], ended['costUsd']], [10, 20, 0.01]);
    assert.ok(!JSON.stringify(sent(f)).includes('payroll'));
  });
});

test('an interrupted turn says so, and an agent error is an AgentError exception', async () => {
  await withEnv(STATS_ON, async () => {
    const f = await start();
    await f.host.deliver('turn.ended', { sessionId: 's1', turnId: 't1', status: 'error', interrupted: true, errorText: `spawn failed in ${process.env['HOME'] ?? '/home/x'}/code` });
    await f.host.clock.advance(15_000);
    assert.equal(sent(f).find((e) => e.event === 'turn_ended')?.properties['status'], 'interrupted');
    const ex = sent(f).find((e) => e.event === '$exception')?.properties ?? {};
    assert.equal(ex['type'], 'AgentError');
    assert.equal(ex['agent'], 'wisp');
    assert.ok(!JSON.stringify(ex).includes(String(process.env['HOME'])));
  });
});

test("Auto's choice goes with the turn as fixed values, from wisp.router's ext slot", () => {
  const s = session({ ext: { 'wisp.router': { route: { goal: 'fix', type: 'bug', size: 'small', explored: 1, propensity: 0.4, tier: 'mid', pinned: true } } } });
  assert.deepEqual(routeProps(s), {
    routed: true, routeGoal: 'fix', routeType: 'bug', routeSize: 'small', routeExplored: true, routeTrying: false, routePropensity: 0.4,
    routeTier: 'mid', routeTaste: undefined, routePinned: true, routeSuggested: false, routeEffort: 'default',
  });
  assert.deepEqual(routeProps(session()), {});
  assert.equal(endedProps(s, undefined, { status: 'done' })['routed'], true);
});

test('stats off: turns are not even read', async () => {
  await withEnv({ WISP_TELEMETRY: '0' }, async () => {
    const f = await start();
    await f.host.deliver('turn.started', { sessionId: 's1', turnId: 't0' });
    assert.ok(!f.host.ran.some((r) => r.cmd === 'runtime.get'));
  });
});

test('app_started lists the installed harnesses and their versions', async () => {
  await withEnv(STATS_ON, async () => {
    const f = await start({ agents: [{ id: 'claude', name: 'Claude Code', available: true, version: '2.1.0' }, { id: 'codex', name: 'Codex', available: false }] });
    await f.host.clock.advance(15_000);
    const ev = sent(f).find((e) => e.event === 'app_started');
    assert.deepEqual(ev?.properties['agentsInstalled'], ['claude']);
    assert.equal(ev?.properties['claudeVersion'], '2.1.0');
    assert.equal(ev?.properties['codexVersion'], undefined);
  });
});

test('the first-run line until the page has shown it, and never with stats off', async () => {
  await withEnv(STATS_ON, async () => {
    const f = await start();
    const svc = f.host.provided.get('telemetry.service') as TelemetryService;
    assert.equal(svc.startupNotice(), NOTICE);
    assert.match(NOTICE, /Opt out: Settings, or WISP_TELEMETRY=0 \/ DO_NOT_TRACK=1\./);
    f.host.settings.set('telemetry.telemetryNotice', 'seen');
    assert.equal(svc.startupNotice(), null);
    f.host.settings.set('telemetry.telemetryNotice', 'x');
    f.host.settings.set('telemetry', 'off');
    assert.equal(svc.startupNotice(), null);
    assert.equal(svc.enabled(), false);
  });
});

test('other plugins count through the service; captureError goes as $exception', async () => {
  await withEnv(STATS_ON, async () => {
    const f = await start();
    const svc = f.host.provided.get('telemetry.service') as TelemetryService;
    svc.track('ship', { agent: 'claude', draft: false });
    svc.captureError({ name: 'Error', message: 'boom' }, { route: 'POST /sessions' });
    await f.host.clock.advance(15_000);
    assert.deepEqual(sent(f).map((e) => e.event).filter((e) => e !== 'app_started'), ['ship', '$exception']);
    assert.equal(sent(f).find((e) => e.event === 'ship')?.properties['draft'], false);
  });
});

test('switching it off leaks nothing and keeps what was queued for the next start', async () => {
  await withEnv(STATS_ON, async () => {
    const listeners = process.listenerCount('uncaughtExceptionMonitor');
    const f = await start();
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), listeners + 1);
    const svc = f.host.provided.get('telemetry.service') as TelemetryService;
    svc.track('queued_at_exit');
    f.host.stop();
    await settle();
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), listeners);
    assert.equal(f.host.provided.has('telemetry.service'), false);
    assert.equal(f.host.routes.length, 0);
    assert.equal(f.host.subs.length, 0);
    assert.ok(f.host.clock.timers.every((t) => !t.alive));
    const rows = f.host.store.query('telemetry.outbox', { where: { box: 'pending' } });
    assert.equal(rows.length, 1);
  });
});

test('a missing permission is refused: every route names one', async () => {
  const f = await start();
  assert.deepEqual(f.host.routes.map((r) => `${r.method} ${r.parts.join('/')} ${r.permission}`), ['POST feedback feedback:send', 'POST telemetry/event telemetry:track']);
});
