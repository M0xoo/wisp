// A reply wisp answered too late: the page gives the text back and it may be sent again. The second
// send carries the same sendId, so a message the server already took never runs twice.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, taskRuns, tmp, until } from './helpers.js';

const RECORD = tmp('reply-once-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('reply-once-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_RETRO_IDLE_MS = '3600000';
process.env.CLAUDE_CONFIG_DIR = tmp('reply-once-claude');
installFakeBins();
const { startServer } = await import('../server/index.js');
let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const post = async (p, body) => {
  const r = await fetch(`${base}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const get = async (p) => (await fetch(`${base}/api${p}`)).json();
const settled = (id, turns) => until(async () => {
  const s = await get(`/sessions/${id}`);
  return s.state === 'review' && s.turns.length === turns && s.turns.at(-1).status !== 'running' && s;
}, { timeout: 15_000 });
const task = async (prompt = 'first') => {
  const { json: s } = await post('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false });
  await settled(s.id, 1);
  return s;
};
const runsOf = (text) => taskRuns(RECORD, 'claude').filter((r) => r.stdin.includes(text)).length;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});
afterEach(() => delete process.env.FAKE_HANG);

test('the same send twice, one after the other, runs once and answers the same', async () => {
  const s = await task();
  const body = { text: 'only once please', sendId: 'send-a' };
  const one = await post(`/sessions/${s.id}/reply`, body);
  await settled(s.id, 2);
  const two = await post(`/sessions/${s.id}/reply`, body);
  assert.equal(one.status, 200);
  assert.deepEqual(two, one);
  await new Promise((r) => setTimeout(r, 400)); // a second run would have started by now
  assert.equal((await settled(s.id, 2)).turns.length, 2);
  assert.equal(runsOf('only once please'), 1);
});

test('sent again after its run ended: the page hears how the task stands, or it stays on Working', { timeout: 15_000 }, async () => {
  const s = await task();
  const body = { text: 'landed late', sendId: 'send-j' };
  await post(`/sessions/${s.id}/reply`, body);
  await settled(s.id, 2);
  const ctl = new AbortController();
  const stream = (await fetch(`${base}/api/events`, { signal: ctl.signal })).body.pipeThrough(new TextDecoderStream()).getReader();
  await stream.read(); // hello: it's listening
  await post(`/sessions/${s.id}/reply`, body);
  let heard = '';
  while (!heard.includes('"state":"review"')) heard += (await stream.read()).value;
  assert.match(heard, /event: summary/);
  assert.ok(heard.includes(s.id));
  ctl.abort();
});

test('the same send twice at once: the second waits for the first, nothing runs twice', async () => {
  const s = await task();
  const body = { text: 'at the same moment', sendId: 'send-b' };
  const [one, two] = await Promise.all([post(`/sessions/${s.id}/reply`, body), post(`/sessions/${s.id}/reply`, body)]);
  assert.deepEqual(two, one);
  await settled(s.id, 2);
  assert.equal(runsOf('at the same moment'), 1);
});

test('the same words with another sendId are another message', async () => {
  const s = await task();
  await post(`/sessions/${s.id}/reply`, { text: 'go on', sendId: 'send-c' });
  await settled(s.id, 2);
  await post(`/sessions/${s.id}/reply`, { text: 'go on', sendId: 'send-d' });
  await settled(s.id, 3);
  // Nor does a send without one, as from the CLI, the API or an older page.
  await post(`/sessions/${s.id}/reply`, { text: 'go on' });
  await settled(s.id, 4);
  await post(`/sessions/${s.id}/reply`, { text: 'go on' });
  await settled(s.id, 5);
});

test('a refused send did nothing, so sending it again goes through', async () => {
  const s = await task();
  const refused = await post(`/sessions/${s.id}/reply`, { text: 'in a bad mode', mode: 'nope', sendId: 'send-e' });
  assert.equal(refused.status, 400);
  const ok = await post(`/sessions/${s.id}/reply`, { text: 'in a bad mode', sendId: 'send-e' });
  assert.equal(ok.status, 200);
  await settled(s.id, 2);
});

test('a sendId is per task', async () => {
  const [a, b] = [await task(), await task()];
  await post(`/sessions/${a.id}/reply`, { text: 'to the first', sendId: 'send-f' });
  await settled(a.id, 2);
  await post(`/sessions/${b.id}/reply`, { text: 'to the second', sendId: 'send-f' });
  await settled(b.id, 2);
});

test('sent again while a run is going: queued once, and what was queued stays', async () => {
  const s = await task();
  process.env.FAKE_HANG = '1';
  await post(`/sessions/${s.id}/reply`, { text: 'a long run' });
  await until(async () => (await get(`/sessions/${s.id}`)).agentSessionId && srv.store.get(s.id).turns.at(-1).status === 'running');
  await post(`/sessions/${s.id}/reply`, { text: 'queued before', queue: true });
  const body = { text: 'came back late', queue: true, sendId: 'send-g' };
  await post(`/sessions/${s.id}/reply`, body);
  await post(`/sessions/${s.id}/reply`, body);
  assert.deepEqual(srv.store.get(s.id).queue.map((q) => q.text), ['queued before', 'came back late']);
  // Stopping keeps them.
  await post(`/sessions/${s.id}/stop`, {});
  await until(() => srv.store.get(s.id).turns.at(-1).status !== 'running');
  assert.deepEqual(srv.store.get(s.id).queue.map((q) => q.text), ['queued before', 'came back late']);
});

test('sent again while interrupting: the second send does not interrupt again', async () => {
  const s = await task();
  process.env.FAKE_HANG = '1';
  await post(`/sessions/${s.id}/reply`, { text: 'a long run' });
  await until(async () => (await get(`/sessions/${s.id}`)).agentSessionId && srv.store.get(s.id).turns.at(-1).status === 'running');
  delete process.env.FAKE_HANG;
  const body = { text: 'stop and do this', sendId: 'send-h' };
  await post(`/sessions/${s.id}/reply`, body);
  await post(`/sessions/${s.id}/reply`, body);
  await settled(s.id, 3);
  assert.equal(runsOf('stop and do this'), 1);
});

test('an answer sent again gets the same answer, and the run goes on once', async () => {
  const s = await task();
  await post(`/sessions/${s.id}/reply`, { text: 'ASK me first' });
  await until(async () => (await get(`/sessions/${s.id}`)).ask);
  const body = { text: 'Yes', sendId: 'send-i' };
  const one = await post(`/sessions/${s.id}/answer`, body);
  assert.deepEqual(one.json, { ok: true });
  assert.deepEqual((await post(`/sessions/${s.id}/answer`, body)).json, { ok: true });
  await settled(s.id, 2);
});
