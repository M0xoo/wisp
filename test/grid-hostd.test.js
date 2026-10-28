// hostd making room: a box starts while there's room (maxRunning, and the host's memory with
// `admit`); otherwise the box quiet longest is stopped like an idle one, or the start waits in
// line. Scheduled wakes wait behind people and never evict. Fake boxes (fixtures/fake-box.mjs)
// stand in for wisp, so this is about hostd alone.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hostd } from '../grid/hostd.js';
import { tmp, until } from './helpers.js';

const BOX = fileURLToPath(new URL('./fixtures/fake-box.mjs', import.meta.url));
const all = [];
after(async () => Promise.all(all.map((h) => h.close())));

function hostd(opts = {}) {
  const dataDir = tmp('hostd');
  const h = new Hostd({ dataDir, idleMs: 1e9, checkMs: 60, maxRunning: 2, evictAfterMs: 0, queueMs: 5000, wispBin: BOX, secretFor: () => 's'.repeat(40), urlFor: (u) => `http://${u.handle}.test`, ...opts });
  const stops = [];
  h.on('change', (e) => e.state === 'stopped' && stops.push([e.user.handle, e.event]));
  // What a user's wisp says to /api/status (live turns, open pages, …).
  h.status = (u, s) => {
    const home = h.dirs(u).home;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify(s));
  };
  h.stops = stops;
  all.push(h);
  return h;
}
const user = (handle) => ({ id: `u-${handle}`, handle });
// hostd sees each box's status on its tick; wait for one so it knows who's quiet.
const seen = (h, u) => until(() => h.inst.get(u.id)?.status, { what: `${u.handle}'s status` });

test('full: the box quiet longest is stopped like an idle one, and the new one starts', async () => {
  const h = hostd();
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user);
  await h.ensure(a);
  await h.ensure(b);
  h.touch(b.id); // ada has been quiet longer
  await seen(h, a);
  await seen(h, b);
  await h.ensure(c);
  assert.deepEqual([h.state(a.id), h.state(b.id), h.state(c.id)], ['stopped', 'running', 'running']);
  assert.deepEqual(h.stops, [['ada', 'evicted']]);
  // It wakes again on its next request, making room the same way.
  await h.ensure(a);
  assert.equal(h.state(a.id), 'running');
  assert.equal(h.state(b.id), 'stopped');
});

test('a box with a page open, a turn running or a schedule due soon is never stopped for room', async () => {
  const h = hostd({ queueMs: 600 });
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user);
  h.status(a, { clients: 1 });
  h.status(b, { nextWakeAt: Date.now() + 60_000 });
  await h.ensure(a);
  await h.ensure(b);
  await seen(h, a);
  await seen(h, b);
  const t = Date.now();
  await assert.rejects(h.ensure(c), (err) => err.status === 503 && /full/.test(err.message));
  assert.ok(Date.now() - t >= 500, 'it waited in line first');
  assert.deepEqual(h.stops.filter(([, e]) => e !== 'failed'), []);
  assert.equal(h.state(c.id), 'stopped');
  h.status(b, { live: 1 });
  await until(() => h.inst.get(b.id).status.live === 1);
  await assert.rejects(h.ensure(c), /full/);
});

test('every box busy: the start waits in line and goes as soon as one stops', async () => {
  const h = hostd();
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user);
  h.status(a, { live: 1 });
  h.status(b, { live: 1 });
  await h.ensure(a);
  await h.ensure(b);
  await seen(h, a);
  const states = [];
  h.on('change', (e) => e.user.id === c.id && states.push(e.state));
  const ready = h.ensure(c);
  await until(() => states.includes('queued'), { what: 'queued' });
  assert.equal(h.state(c.id), 'queued');
  await h.stop(a.id, 'put to sleep');
  await ready;
  assert.equal(h.state(c.id), 'running');
  assert.deepEqual(states, ['queued', 'starting', 'running']);
  assert.ok(h.takePeak().waits >= 1);
});

test('people go before scheduled wakes, and a wake never stops anyone', async () => {
  const h = hostd({ maxRunning: 1 });
  const [a, b, c] = ['ada', 'bob', 'cyd'].map(user);
  h.status(a, { live: 1 });
  await h.ensure(a);
  await seen(h, a);
  const order = [];
  const wake = h.ensure(b, { wake: true }).then(() => order.push('bob'));
  await until(() => h.state(b.id) === 'queued');
  const person = h.ensure(c).then(() => order.push('cyd'));
  await until(() => h.state(c.id) === 'queued');
  h.status(a, {}); // quiet now: a person's start may stop it, a wake's may not
  await person;
  assert.deepEqual(order, ['cyd']);
  assert.equal(h.state(a.id), 'stopped');
  assert.equal(h.state(b.id), 'queued', 'the wake still waits: cyd has the only place');
  await h.stop(c.id, 'put to sleep');
  await wake;
  assert.deepEqual(order, ['cyd', 'bob']);
});

test('admit: a box starts only with the memory for it; capacity says how many more fit', async () => {
  let mem = 4000;
  const h = hostd({ maxRunning: 10, admit: { boxMb: 1000, reserveMb: 1000 }, memory: () => mem, queueMs: 300 });
  const [a, b] = ['ada', 'bob'].map(user);
  assert.equal(h.capacity(), 3);
  await h.ensure(a);
  h.status(a, { live: 1 });
  await seen(h, a);
  mem = 1500; // ada's box took most of it
  assert.equal(h.capacity(), 1);
  await assert.rejects(h.ensure(b), /full/);
  mem = 2500;
  await h.ensure(b);
  assert.equal(h.state(b.id), 'running');
  assert.deepEqual(h.takePeak(), { peak: 2, waits: 1 });
  assert.deepEqual(h.takePeak(), { peak: 2, waits: 0 }, 'the peak starts again from what is up now');
});

test('close: a start still waiting for room gives up, and nothing changes after close returns', async () => {
  const h = hostd({ maxRunning: 1 });
  const [a, b] = ['ada', 'bob'].map(user);
  h.status(a, { live: 1 });
  await h.ensure(a);
  const queued = assert.rejects(h.ensure(b), /shutting down/);
  await until(() => h.state(b.id) === 'queued');
  const late = [];
  await h.close();
  h.on('change', (e) => late.push(e));
  await queued;
  assert.equal(h.state(a.id), 'stopped');
  assert.equal(h.state(b.id), 'stopped');
  await assert.rejects(h.ensure(b), /shutting down/);
  await new Promise((r) => setTimeout(r, 300));
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
  const h = hostd();
  const a = user('ada');
  const oom = async () => (await seen(h, a), h.inst.get(a.id).status.oom);
  await h.ensure(a);
  assert.equal(await oom(), '');
  h.inst.get(a.id).child.kill('SIGKILL'); // what the kernel's OOM killer does (docker: exit 137)
  await until(() => h.stops.some(([, e]) => e === 'out of memory'), { what: 'the out-of-memory stop' });
  h.inst.get(a.id).status = null;
  await h.ensure(a);
  assert.equal(await oom(), '1');
  // Stopped on purpose (even hard), it's not memory; and the next start is a plain one again.
  await h.stop(a.id, 'put to sleep');
  h.inst.get(a.id).status = null;
  await h.ensure(a);
  assert.equal(await oom(), '');
  assert.deepEqual(h.stops, [['ada', 'out of memory'], ['ada', 'put to sleep']]);
});
