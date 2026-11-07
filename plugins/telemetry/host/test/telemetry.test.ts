// The PostHog client (v1 server/telemetry.js): who may send, what an event carries, the outboxes.
// Ports the unit parts of v1 test/feedback.test.js, desktop-tauri.test.js and try-two-ways.test.js.
import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import type { Json } from '@wisp/kernel';
import { openStore } from '@wisp/store';
import { tables } from '../src/schema.ts';
import { envDisabled, feedbackAvailable, MAX_QUEUE, shellOf, Telemetry, type Env } from '../src/telemetry.ts';

const COMMON = { $lib: 'wisp', $process_person_profile: false, version: '2.0.0', os: 'darwin', osRelease: '24', arch: 'arm64', node: '22', shell: 'browser' };

function make(o: { env?: Env; setting?: Json; post?: (b: Json[]) => Promise<boolean> } = {}) {
  const store = openStore({ path: ':memory:' });
  const sent: Json[][] = [];
  const t = new Telemetry({
    store,
    tables: tables(store),
    env: o.env ?? {},
    setting: () => o.setting,
    post: o.post ?? (async (b) => (sent.push(b), true)),
    scrub: { home: os.homedir(), root: '/opt/wisp' },
    common: COMMON,
    now: () => Date.UTC(2026, 10, 7),
  });
  return { t, store, sent };
}

const props = (e: Json | undefined): Record<string, Json> => ((e as { properties: Record<string, Json> }).properties);

test('opt-outs: no key, DO_NOT_TRACK=1, WISP_TELEMETRY=0, CI, or the Settings switch off', () => {
  assert.equal(envDisabled({}), false);
  for (const env of [{ WISP_POSTHOG_KEY: '' }, { DO_NOT_TRACK: '1' }, { WISP_TELEMETRY: '0' }, { WISP_TELEMETRY: 'off' }, { CI: 'true' }]) assert.equal(envDisabled(env), true, JSON.stringify(env));
  for (const env of [{ DO_NOT_TRACK: '0' }, { CI: 'false' }, { WISP_TELEMETRY: '1' }]) assert.equal(envDisabled(env), false, JSON.stringify(env));
  assert.equal(make({ setting: 'off' }).t.enabled, false);
  assert.equal(make({ setting: 'on' }).t.enabled, true);
  assert.equal(make().t.enabled, true, 'unset is on');
});

test('the count goes through the off switch; what leaves holds only what every event carries', () => {
  const off = make({ setting: 'off' });
  off.t.track('try_two_ways', {});
  assert.equal(off.t.queue.length, 0, 'Settings off: nothing queued');
  const env = make({ env: { WISP_TELEMETRY: '0' } });
  env.t.track('try_two_ways', {});
  assert.equal(env.t.queue.length, 0, 'WISP_TELEMETRY=0: nothing queued');
  const on = make();
  on.t.track('try_two_ways', {});
  assert.deepEqual(Object.keys(props(on.t.queue[0])).sort(), [...Object.keys(COMMON), 'distinct_id'].sort());
  assert.equal((on.t.queue[0] as { event: string }).event, 'try_two_ways');
});

test('one random id per install, made on the first event and kept in the store', () => {
  const { t } = make();
  assert.equal(t.installId(false), undefined);
  t.track('a');
  t.track('b');
  const id = t.installId(false);
  assert.match(String(id), /^[0-9a-f-]{36}$/);
  assert.ok(t.queue.every((e) => props(e)['distinct_id'] === id));
});

test('undefined props are dropped; the queue flushes itself at 50', async () => {
  const { t, sent } = make();
  t.track('x', { a: 1, b: undefined });
  assert.deepEqual(Object.hasOwn(props(t.queue[0]), 'b'), false);
  for (let i = 1; i < MAX_QUEUE; i++) t.track('x');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.length, MAX_QUEUE);
  assert.equal(t.queue.length, 0);
});

test('a failed flush drops the events: telemetry never gets in the way', async () => {
  const { t } = make({ post: async () => false });
  t.track('x');
  await t.flush();
  assert.equal(t.queue.length, 0);
});

test('captureError: PostHog exception format, message and stack scrubbed of paths', () => {
  const { t } = make();
  const home = os.homedir();
  t.captureError({ name: 'TypeError', message: `cannot read ${home}/code/secret-project/a.ts`, stack: `TypeError: x\n    at run (/opt/wisp/src/a.ts:3:4)\n    at other (${home}/code/app/node_modules/x/y.js:1:2)` }, { route: 'GET /sessions/:id' });
  const p = props(t.queue[0]);
  assert.equal((t.queue[0] as { event: string }).event, '$exception');
  assert.equal(p['route'], 'GET /sessions/:id');
  const [ex] = p['$exception_list'] as { type: string; value: string; mechanism: Json; stacktrace: { frames: { filename: string; in_app: boolean; function: string }[] } }[];
  assert.equal(ex?.type, 'TypeError');
  assert.equal(ex?.value, 'cannot read …/a.ts', 'a path outside wisp keeps only its file name');
  assert.ok(!JSON.stringify(ex).includes(home), 'no home folder');
  assert.deepEqual(ex?.mechanism, { handled: true, synthetic: false });
  const frames = ex?.stacktrace.frames ?? [];
  assert.equal(frames.at(-1)?.function, 'run', 'innermost last');
  assert.equal(frames.at(-1)?.filename, '<wisp>/src/a.ts');
  assert.equal(frames.at(-1)?.in_app, true);
  assert.equal(frames[0]?.in_app, false);
});

test('a crash is captured unhandled and queued for the next start', () => {
  const { t, store } = make();
  t.crashed({ name: 'RangeError', message: 'boom' });
  assert.equal(t.queue.length, 0);
  const again = new Telemetry({ store, tables: tables(store), env: {}, setting: () => undefined, post: async () => true, scrub: { home: '', root: '' }, common: COMMON, now: () => 0 });
  void again.restore();
  const [ex] = props(again.queue[0])['$exception_list'] as { type: string; mechanism: { handled: boolean } }[];
  assert.equal(ex?.type, 'RangeError');
  assert.equal(ex?.mechanism.handled, false);
});

test('what was queued at shutdown goes with the next start, unless stats are off by then', () => {
  const { t, store } = make();
  t.track('a');
  t.persist();
  const off = new Telemetry({ store, tables: tables(store), env: {}, setting: () => 'off', post: async () => true, scrub: { home: '', root: '' }, common: COMMON, now: () => 0 });
  void off.restore();
  assert.equal(off.queue.length, 0, 'off: dropped, and not kept either');
  assert.equal(store.count(tables(store).outbox, { box: 'pending' }), 0);
});

test('feedback goes out with usage stats off, under a one-off id, home dir scrubbed', async () => {
  const { t, sent } = make({ setting: 'off' });
  t.track('ignored');
  const ok = await t.feedback('feedback', { text: `broke in ${os.homedir()}/code/app`, rating: 'down' });
  assert.equal(ok, true);
  const ev = sent[0]?.[0] as { event: string; properties: Record<string, Json> };
  assert.equal(ev.event, 'feedback');
  assert.equal(ev.properties['rating'], 'down');
  assert.equal(ev.properties['text'], 'broke in ~/code/app');
  assert.equal(ev.properties['version'], '2.0.0');
  assert.equal(t.installId(false), undefined, 'not tied to the analytics id');
});

test('WISP_FEEDBACK=0 sends nothing', async () => {
  const { t, sent } = make({ env: { WISP_FEEDBACK: '0' } });
  assert.equal(feedbackAvailable({ WISP_FEEDBACK: '0' }), false);
  assert.equal(await t.feedback('feedback', { text: 'hi' }), false);
  assert.equal(sent.length, 0);
});

test('offline feedback waits in the outbox and goes with the next one, or the next start', async () => {
  let online = false;
  const sent: Json[][] = [];
  const { t, store } = make({ post: async (b) => (online && sent.push(b), online) });
  assert.equal(await t.feedback('feedback', { text: 'first' }), false);
  assert.equal(store.count(tables(store).outbox, { box: 'feedback' }), 1);
  online = true;
  assert.equal(await t.feedback('feedback', { text: 'second' }), true);
  assert.deepEqual(sent[0]?.map((e) => props(e)['text']), ['first', 'second']);
  assert.equal(store.count(tables(store).outbox, { box: 'feedback' }), 0);

  online = false;
  await t.feedback('feedback', { text: 'third' });
  online = true;
  const next = new Telemetry({ store, tables: tables(store), env: {}, setting: () => undefined, post: async (b) => (sent.push(b), true), scrub: { home: '', root: '' }, common: COMMON, now: () => 0 });
  await next.restore();
  assert.deepEqual(sent.at(-1)?.map((e) => props(e)['text']), ['third']);
  assert.equal(store.count(tables(store).outbox, { box: 'feedback' }), 0);
});

test('telemetry tells the Tauri shell and the grid from the browser', () => {
  assert.equal(shellOf({ WISP_DESKTOP: 'tauri' }), 'tauri');
  assert.equal(shellOf({ WISP_GRID_URL: 'https://grid.example' }), 'grid');
  assert.equal(shellOf({}), 'browser');
});
