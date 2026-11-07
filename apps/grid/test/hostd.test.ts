// hostd making room: a box starts while there's room (maxRunning, and the host's memory with
// `admit`); otherwise the box quiet longest is stopped like an idle one, or the start waits in
// line. Scheduled wakes wait behind people and never evict. Fake boxes (fixtures/fake-box.ts)
// stand in for wisp, so this is about hostd alone.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Hostd, type HostdOptions, type Inst } from '../src/hostd.ts';
import type { BoxUser } from '../src/rows.ts';
import { fixture, tmp, until } from './helpers.ts';

const BOX = fixture('fake-box.ts');
const all: Hostd[] = [];
after(async () => {
  await Promise.all(all.map((h) => h.close()));
});

interface Rig {
  h: Hostd;
  /** What a user's wisp says to /api/status (live turns, open pages, …). */
  status(u: BoxUser, s: Record<string, unknown>): void;
  stops: [string, string][];
  /** hostd's record of the box: there once ensure() ran */
  of(u: BoxUser): Inst;
}

function hostd(opts: Partial<HostdOptions> = {}): Rig {
  const dataDir = tmp('hostd');
  const h = new Hostd({ dataDir, idleMs: 1e9, checkMs: 60, maxRunning: 2, evictAfterMs: 0, queueMs: 5000, wispBin: BOX, secretFor: () => 's'.repeat(40), urlFor: (u) => `http://${u.handle}.test`, ...opts });
  const stops: [string, string][] = [];
  h.on('change', (e: { user: BoxUser; state: string; event: string }) => {
    if (e.state === 'stopped') stops.push([e.user.handle, e.event]);
  });
  all.push(h);
  return {
    h,
    stops,
    status(u, s) {
      const home = h.dirs(u).home;
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify(s));
    },
    of(u) {
      const i = h.inst.get(u.id);
      assert.ok(i, `${u.handle} is known to hostd`);
      return i;
    },
  };
}
const user = (handle: string): BoxUser => ({ id: `u-${handle}`, handle });
// hostd sees each box's status on its tick; wait for one so it knows who's quiet.
const seen = (r: Rig, u: BoxUser) => until(() => r.h.inst.get(u.id)?.status, { what: `${u.handle}'s status` });

test('idle: a box whose channel is still answering isn’t stopped, and it is once that’s over', async () => {
  const r = hostd({ idleMs: 0 });
  const a = user('ada');
  r.status(a, { channels: 1 });
  await r.h.ensure(a);
  await until(() => r.h.inst.get(a.id)?.status?.channels === 1, { what: 'its status' });
  const ticks = r.of(a).status;
  await until(() => r.of(a).status !== ticks, { what: 'another tick' });
  assert.equal(r.h.state(a.id), 'running');
  r.status(a, { channels: 0 });
  await until(() => r.h.state(a.id) === 'stopped', { what: 'the idle stop' });
});

test('idle: a status read before a delivery ended says nothing about after it', async () => {
  const r = hostd({ idleMs: 0, checkMs: 1e9 });
  const a = user('ada');
  await r.h.ensure(a);
  const i = r.of(a);
  const port = i.port;
  const release = r.h.begin(a.id, { touch: false });
  // The delivery's 2xx is read while this status, quiet because it's older, is still on its way.
  const late = http.createServer((_req, res) => {
    release();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((done) => late.listen(0, '127.0.0.1', done));
  const at = late.address();
  i.port = typeof at === 'object' && at ? at.port : 0;
  i.lastTouch = 0;
  await new Promise((done) => setTimeout(done, 5));
  await r.h.tick();
  late.close();
  i.port = port;
  assert.equal(r.h.state(a.id), 'running', 'stopped on a stale status');
  await r.h.tick();
  assert.equal(r.h.state(a.id), 'stopped', 'the next tick sees the truth');
});

test('full: a box whose channel is still answering isn’t the one to go', async () => {
  const r = hostd({ maxRunning: 1 });
  const [a, b] = ['ada', 'bob'].map(user) as [BoxUser, BoxUser];
  r.status(a, { channels: 1 });
  await r.h.ensure(a);
  await until(() => r.h.inst.get(a.id)?.status?.channels === 1, { what: 'its status' });
  const start = r.h.ensure(b);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(r.h.state(a.id), 'running');
  r.status(a, {});
  await start;
  assert.deepEqual(r.stops, [['ada', 'evicted']]);
});

test('full: the box quiet longest is stopped like an idle one, and the new one starts', async () => {
  const r = hostd();
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user) as [BoxUser, BoxUser, BoxUser];
  await r.h.ensure(a);
  await r.h.ensure(b);
  r.h.touch(b.id); // ada has been quiet longer
  await seen(r, a);
  await seen(r, b);
  await r.h.ensure(c);
  assert.deepEqual([r.h.state(a.id), r.h.state(b.id), r.h.state(c.id)], ['stopped', 'running', 'running']);
  assert.deepEqual(r.stops, [['ada', 'evicted']]);
  // It wakes again on its next request, making room the same way.
  await r.h.ensure(a);
  assert.equal(r.h.state(a.id), 'running');
  assert.equal(r.h.state(b.id), 'stopped');
});

test('a box with a page open, a turn running or a schedule due soon is never stopped for room', async () => {
  const r = hostd({ queueMs: 600 });
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user) as [BoxUser, BoxUser, BoxUser];
  r.status(a, { clients: 1 });
  r.status(b, { nextWakeAt: Date.now() + 60_000 });
  await r.h.ensure(a);
  await r.h.ensure(b);
  await seen(r, a);
  await seen(r, b);
  const t = Date.now();
  await assert.rejects(r.h.ensure(c), (err: Error & { status?: number }) => err.status === 503 && /full/.test(err.message));
  assert.ok(Date.now() - t >= 500, 'it waited in line first');
  assert.deepEqual(r.stops.filter(([, e]) => e !== 'failed'), []);
  assert.equal(r.h.state(c.id), 'stopped');
  r.status(b, { live: 1 });
  await until(() => r.of(b).status?.live === 1);
  await assert.rejects(r.h.ensure(c), /full/);
});

test('every box busy: the start waits in line and goes as soon as one stops', async () => {
  const r = hostd();
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user) as [BoxUser, BoxUser, BoxUser];
  r.status(a, { live: 1 });
  r.status(b, { live: 1 });
  await r.h.ensure(a);
  await r.h.ensure(b);
  await seen(r, a);
  const states: string[] = [];
  r.h.on('change', (e: { user: BoxUser; state: string }) => {
    if (e.user.id === c.id) states.push(e.state);
  });
  const ready = r.h.ensure(c);
  await until(() => states.includes('queued'), { what: 'queued' });
  assert.equal(r.h.state(c.id), 'queued');
  await r.h.stop(a.id, 'put to sleep');
  await ready;
  assert.equal(r.h.state(c.id), 'running');
  assert.deepEqual(states, ['queued', 'starting', 'running']);
  assert.ok(r.h.takePeak().waits >= 1);
});

test('people go before scheduled wakes, and a wake never stops anyone', async () => {
  const r = hostd({ maxRunning: 1 });
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user) as [BoxUser, BoxUser, BoxUser];
  r.status(a, { live: 1 });
  await r.h.ensure(a);
  await seen(r, a);
  const order: string[] = [];
  const wake = r.h.ensure(b, { wake: true }).then(() => order.push('bob'));
  await until(() => r.h.state(b.id) === 'queued');
  const person = r.h.ensure(c).then(() => order.push('cyd'));
  await until(() => r.h.state(c.id) === 'queued');
  r.status(a, {}); // quiet now: a person's start may stop it, a wake's may not
  await person;
  assert.deepEqual(order, ['cyd']);
  assert.equal(r.h.state(a.id), 'stopped');
  assert.equal(r.h.state(b.id), 'queued', 'the wake still waits: cyd has the only place');
  await r.h.stop(c.id, 'put to sleep');
  await wake;
  assert.deepEqual(order, ['cyd', 'bob']);
});

test('admit: a box starts only with the memory for it; capacity says how many more fit', async () => {
  let mem = 4000;
  const r = hostd({ maxRunning: 10, admit: { boxMb: 1000, reserveMb: 1000 }, memory: () => mem, queueMs: 300 });
  const [a, b] = ['ada', 'bob'].map(user) as [BoxUser, BoxUser];
  assert.equal(r.h.capacity(), 3);
  await r.h.ensure(a);
  r.status(a, { live: 1 });
  await seen(r, a);
  mem = 1500; // ada's box took most of it
  assert.equal(r.h.capacity(), 1);
  await assert.rejects(r.h.ensure(b), /full/);
  mem = 2500;
  await r.h.ensure(b);
  assert.equal(r.h.state(b.id), 'running');
  assert.deepEqual(r.h.takePeak(), { peak: 2, waits: 1 });
  assert.deepEqual(r.h.takePeak(), { peak: 2, waits: 0 }, 'the peak starts again from what is up now');
});

test('close: a start still waiting for room gives up, and nothing changes after close returns', async () => {
  const r = hostd({ maxRunning: 1 });
  const [a, b] = ['ada', 'bob'].map(user) as [BoxUser, BoxUser];
  r.status(a, { live: 1 });
  await r.h.ensure(a);
  const queued = assert.rejects(r.h.ensure(b), /shutting down/);
  await until(() => r.h.state(b.id) === 'queued');
  const late: unknown[] = [];
  await r.h.close();
  r.h.on('change', (e: unknown) => late.push(e));
  await queued;
  assert.equal(r.h.state(a.id), 'stopped');
  assert.equal(r.h.state(b.id), 'stopped');
  await assert.rejects(r.h.ensure(b), /shutting down/);
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(late, [], 'the grid closes its database once close returns');
});

test('admit is on by default for containers on Linux only', () => {
  const d = tmp('hostd-admit');
  const p = new Hostd({ dataDir: d, driver: 'process', idleMs: 1e9, checkMs: 1e9 });
  const c = new Hostd({ dataDir: d, driver: 'container', idleMs: 1e9, checkMs: 1e9, container: { boxd: '/nonexistent.sock' } });
  const off = new Hostd({ dataDir: d, driver: 'container', idleMs: 1e9, checkMs: 1e9, admit: false, container: { boxd: '/nonexistent.sock' } });
  all.push(p, c, off);
  assert.equal(p.admit, false);
  assert.deepEqual(c.admit, fs.existsSync('/proc/meminfo') ? { boxMb: 1024, reserveMb: 1024 } : false);
  assert.equal(off.admit, false);
});

test('a box killed when nobody asked ran out of memory: its next start tells its wisp, once', async () => {
  const r = hostd();
  const a = user('ada');
  const oom = async (): Promise<unknown> => (await seen(r, a), r.of(a).status?.['oom']);
  await r.h.ensure(a);
  assert.equal(await oom(), '');
  r.of(a).child?.kill('SIGKILL'); // what the kernel's OOM killer does (docker: exit 137)
  await until(() => r.stops.some(([, e]) => e === 'out of memory'), { what: 'the out-of-memory stop' });
  r.of(a).status = null;
  await r.h.ensure(a);
  assert.equal(await oom(), '1');
  // Stopped on purpose (even hard), it's not memory; and the next start is a plain one again.
  await r.h.stop(a.id, 'put to sleep');
  r.of(a).status = null;
  await r.h.ensure(a);
  assert.equal(await oom(), '');
  assert.deepEqual(r.stops, [
    ['ada', 'out of memory'],
    ['ada', 'put to sleep'],
  ]);
});

test('admit: a sandbox needs its own memory limit’s worth (room for its browser), a box only boxMb', async () => {
  const r = hostd({ maxRunning: 10, admit: { boxMb: 1000, reserveMb: 1000 }, memory: () => 3000, queueMs: 300 });
  const sb: BoxUser = { id: 'u-ada-sb-1', handle: 'sb-1--ada', owner: 'u-ada', sandbox: '1' };
  await assert.rejects(r.h.ensure(sb), /full/, '1000 kept + 2560 for the sandbox > 3000');
  await r.h.ensure(user('bob'));
  assert.equal(r.h.state('u-bob'), 'running', 'a box fits in 1000 + 1000');
});

test('a box gets the BoxPlugins group, its trusted-proxy secret and a clean environment', async () => {
  process.env['GRID_TEST_LEAK'] = 'operator-only';
  try {
    const r = hostd({ env: { ADMIN: 'x', OWNER: 'admin-wins' }, envFor: () => ({ OWNER: 'sandbox-loses', SANDBOX_ONLY: 'y', WISP_GROUP: 'default' }) });
    const a = user('ada');
    await r.h.ensure(a);
    const port = r.h.port(a.id);
    assert.ok(port);
    const env = await new Promise<Record<string, string>>((done, fail) =>
      http
        .get({ host: '127.0.0.1', port, path: '/_test/env' }, (res) => {
          let t = '';
          res.on('data', (d: Buffer) => (t += d));
          res.on('end', () => done(JSON.parse(t) as Record<string, string>));
        })
        .on('error', fail),
    );
    assert.equal(env['GRID_TEST_LEAK'], undefined, 'nothing from the operator’s shell');
    assert.equal(env['WISP_GROUP'], 'box', 'wisp’s own win over a sandbox’s');
    assert.equal(env['WISP_TRUSTED_PROXY_SECRET'], 's'.repeat(40));
    assert.equal(env['WISP_PUBLIC_URL'], 'http://ada.test');
    assert.equal(env['OWNER'], 'admin-wins', 'hostd.env wins over a sandbox’s');
    assert.equal(env['SANDBOX_ONLY'], 'y');
    assert.equal(env['WISP_HOME'], r.h.dirs(a).wisp);
    assert.equal(env['HOME'], r.h.dirs(a).home);
  } finally {
    delete process.env['GRID_TEST_LEAK'];
  }
});
