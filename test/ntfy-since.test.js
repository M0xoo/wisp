// ntfy taps across a restart: where wisp stopped reading is kept, so a tap sent while it was down
// (or its cloud box asleep) lands when it's back, and one it already handled doesn't land twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Remote } from '../server/remote.js';

// A fake ntfy that keeps what's posted to <topic>-reply and answers polls as the real one does:
// since is a time (messages from that second on) or an id (those after it).
async function fakeNtfy(t) {
  const fake = { taps: [], polls: [], clock: Math.floor(Date.now() / 1000) };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const since = u.searchParams.get('since');
    fake.polls.push({ path: u.pathname, since });
    const of = fake.taps.filter((m) => m.path === u.pathname);
    const at = of.findIndex((m) => m.id === since);
    const out = /^\d+$/.test(since) ? of.filter((m) => m.time >= Number(since)) : at < 0 ? of : fake.resend ? of.filter((_, i) => i !== at) : of.slice(at + 1);
    res.writeHead(200);
    res.end(out.map(({ path: _, ...m }) => JSON.stringify(m)).join('\n'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.tap = (remote, { topic = 'wisp-t', ref = 'q1' } = {}) => {
    const s = 's1';
    const sig = remote.sign(s, 'answer', ref, 0);
    fake.taps.push({ id: `m${fake.taps.length + 1}`, event: 'message', time: fake.clock++, path: `/${topic}-reply/json`, message: JSON.stringify({ s, k: 'a', r: ref, i: 0, sig }) });
  };
  return fake;
}

const makeStore = (fake) => {
  const store = { config: { remote: { ntfy: { enabled: true, server: fake.url, topic: 'wisp-t', token: '' } } }, saves: 0, saveConfig: () => store.saves++ };
  return store;
};

// ntfy sends messages of the marker's own second again and leaves dropping them to the client.
test('ntfy: a message sent again acts once and does not move the place back', async (t) => {
  const fake = await fakeNtfy(t);
  fake.resend = true;
  const store = makeStore(fake);
  const { r, acts } = boot(t, store);
  await polled(fake);
  fake.tap(r, { ref: 'q1' });
  fake.tap(r, { ref: 'q2' });
  await until(() => store.config.remote.ntfy.since === 'm2');
  await polled(fake, 5);
  assert.deepEqual(acts.map((a) => a.ref), ['q1', 'q2']);
  assert.equal(store.config.remote.ntfy.since, 'm2');
});

// A wisp that reads ntfy on this store: one run of the server.
function boot(t, store) {
  const acts = [];
  const r = new Remote({ store, act: async (a) => (acts.push(a), 'ok') });
  r.ntfyPollMs = 20;
  t.after(() => r.stop());
  r.start();
  return { r, acts };
}

const until = async (fn) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'timed out');
};
const polled = (fake, n = 1) => {
  const at = fake.polls.length;
  return until(() => fake.polls.length >= at + n);
};

test('ntfy: a tap sent while wisp was down lands when it starts again', async (t) => {
  const fake = await fakeNtfy(t);
  const store = makeStore(fake);
  const one = boot(t, store);
  await polled(fake);
  one.r.stop();
  // wisp stopped reading two hours ago, and the tap came one hour ago: before this run began.
  const now = Math.floor(Date.now() / 1000);
  store.config.remote.ntfy.since = String(now - 7200);
  fake.clock = now - 3600;
  fake.tap(one.r);
  const two = boot(t, store);
  await until(() => two.acts.length === 1);
  assert.equal(two.acts[0].ref, 'q1');
});

test('ntfy: a first start keeps its place too: the next one misses nothing after it', async (t) => {
  const fake = await fakeNtfy(t);
  const store = makeStore(fake);
  const one = boot(t, store);
  await polled(fake);
  one.r.stop();
  assert.match(store.config.remote.ntfy.since || '', /^\d+$/, 'saved before any tap came');
  assert.ok(store.saves >= 1);
});

test('ntfy: a tap already handled is not handled again after a restart', async (t) => {
  const fake = await fakeNtfy(t);
  const store = makeStore(fake);
  const one = boot(t, store);
  await polled(fake);
  fake.tap(one.r, { ref: 'q1' });
  await until(() => one.acts.length === 1);
  await until(() => store.config.remote.ntfy.since === 'm1');
  one.r.stop();
  fake.tap(one.r, { ref: 'q2' });
  const two = boot(t, store);
  await until(() => two.acts.length === 1);
  await polled(fake, 3);
  assert.deepEqual(two.acts.map((a) => a.ref), ['q2']);
});

test('ntfy: where it stopped reading belongs to that topic, on that server, while it stays on', async (t) => {
  const fake = await fakeNtfy(t);
  const store = makeStore(fake);
  const { r } = boot(t, store);
  await polled(fake);
  store.config.remote.ntfy.since = 'm9';
  r.update({ ntfy: { token: 'tk_new' } });
  assert.equal(store.config.remote.ntfy.since, 'm9', 'a new token reads the same topic');
  r.update({ ntfy: { topic: 'wisp-other' } });
  assert.notEqual(store.config.remote.ntfy.since, 'm9', 'another topic has other ids');
  store.config.remote.ntfy.since = 'm9';
  r.update({ ntfy: { enabled: false } });
  assert.equal(store.config.remote.ntfy.since, undefined, 'turned off: taps from then on were not meant for it');
  assert.equal(r.view?.().ntfy?.since, undefined);
});

test('ntfy: a loop stopped while it handles a tap leaves the new topic\'s place alone', async (t) => {
  const fake = await fakeNtfy(t);
  const store = makeStore(fake);
  const acts = [];
  let release;
  const r = new Remote({ store, act: (a) => (acts.push(a), new Promise((_, no) => (release = no))) });
  r.ntfyPollMs = 20;
  t.after(() => r.stop());
  r.start();
  await polled(fake);
  fake.tap(r);
  await until(() => acts.length === 1);
  r.update({ ntfy: { topic: 'wisp-other' } }); // the loop stops while the tap is being handled
  const fresh = store.config.remote.ntfy.since;
  release(new Error('nope'));
  await new Promise((f) => setTimeout(f, 60));
  assert.equal(store.config.remote.ntfy.since, fresh, 'm1 is an id of the old topic');
});
