// What the reply box does with a server that doesn't answer (web/js/features/reply-send.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { answersAsk, sendFollowUp, REPLY_TIMEOUT } = await import('../web/js/features/reply-send.js');
const real = globalThis.fetch;
test.afterEach(() => (globalThis.fetch = real));

const TOO_SLOW = 'wisp took too long to answer. Try again.';
const CANT_REACH = 'Can’t reach wisp. Check the connection and try again.';
// A server that took the request and never answers: only the page's own limit ends it.
const silent = (seen) => (url, opts) => {
  seen.push({ url, body: JSON.parse(opts.body) });
  // A request out holds the process open, as its socket would. AbortSignal.timeout's timer doesn't,
  // and before Node 25 a test whose loop runs empty is cancelled, with every test after it.
  return new Promise((_, reject) => {
    const open = setTimeout(() => reject(new Error('nothing ended the request')), 5000);
    opts.signal?.addEventListener('abort', () => {
      clearTimeout(open);
      reject(opts.signal.reason);
    });
  });
};
const fine = (seen, json = { queued: false }) => async (url, opts) => {
  seen.push({ url, body: JSON.parse(opts.body) });
  return new Response(JSON.stringify(json));
};
let n = 0;
const task = () => `task${++n}`;

test('no answer: it fails in wisp’s words, in time, not after the 30 s and more it hung for', async () => {
  assert.ok(REPLY_TIMEOUT >= 10_000 && REPLY_TIMEOUT < 30_000, `the limit is ${REPLY_TIMEOUT} ms`);
  const seen = [];
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(task(), 'reply', { text: 'hello' }, { timeout: 20 }), { message: TOO_SLOW });
  assert.equal(seen.length, 1);
});

test('every send has a limit, the default one too', async () => {
  let signal;
  globalThis.fetch = async (url, opts) => ((signal = opts.signal), new Response('{}'));
  await sendFollowUp(task(), 'reply', { text: 'hello' });
  assert.ok(signal instanceof AbortSignal);
});

test('sent again after no answer: same sendId, so the server can tell', async () => {
  const seen = [];
  const id = task();
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'hello', attachments: [] }, { timeout: 10 }));
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'hello', attachments: [] }, { timeout: 10 }));
  globalThis.fetch = fine(seen);
  await sendFollowUp(id, 'reply', { text: 'hello', attachments: [] });
  assert.equal(seen.length, 3);
  assert.ok(seen[0].body.sendId);
  assert.equal(seen[1].body.sendId, seen[0].body.sendId);
  assert.equal(seen[2].body.sendId, seen[0].body.sendId);
});

test('a dropped connection may have got through too: same sendId', async () => {
  const seen = [];
  const id = task();
  globalThis.fetch = (url, opts) => (seen.push(JSON.parse(opts.body)), Promise.reject(new TypeError('Failed to fetch')));
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'hello' }), { message: CANT_REACH });
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'hello' }), { message: CANT_REACH });
  assert.equal(seen[1].sendId, seen[0].sendId);
});

test('an answer that became a follow-up is still the same message', async () => {
  // The answer landed: the question has gone, so the box now sends it to /reply.
  const seen = [];
  const id = task();
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(id, 'answer', { text: 'Yes' }, { timeout: 10 }));
  globalThis.fetch = fine(seen);
  await sendFollowUp(id, 'reply', { text: 'Yes', attachments: [], queue: false });
  assert.match(seen[1].url, /\/reply$/);
  assert.equal(seen[1].body.sendId, seen[0].body.sendId);
});

test('after an answer, the same words are a new message', async () => {
  const seen = [];
  const id = task();
  globalThis.fetch = fine(seen);
  await sendFollowUp(id, 'reply', { text: 'go on' });
  await sendFollowUp(id, 'reply', { text: 'go on' });
  assert.notEqual(seen[1].body.sendId, seen[0].body.sendId);
});

test('other words, other files or a refusal: a new message', async () => {
  const seen = [];
  const id = task();
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'one', attachments: [] }, { timeout: 10 }));
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'two', attachments: [] }, { timeout: 10 }));
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'two', attachments: ['f'] }, { timeout: 10 }));
  globalThis.fetch = async (url, opts) => (seen.push({ url, body: JSON.parse(opts.body) }), new Response('{"error":"no"}', { status: 409 }));
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'two', attachments: ['f'] }), { message: 'no', status: 409 });
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'two', attachments: ['f'] }), { message: 'no' });
  const ids = seen.map((x) => x.body.sendId);
  assert.equal(new Set(ids.slice(0, 3)).size, 3);
  assert.notEqual(ids[4], ids[3], 'a refusal did nothing: nothing to tell apart');
});

test('a message given back long ago is a new one when sent again', async (t) => {
  const seen = [];
  const id = task();
  const now = Date.now();
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'continue' }, { timeout: 10 }));
  t.mock.method(Date, 'now', () => now + 11 * 60_000);
  await assert.rejects(sendFollowUp(id, 'reply', { text: 'continue' }, { timeout: 10 }));
  assert.notEqual(seen[1].body.sendId, seen[0].body.sendId);
});

test('tasks keep their own sends apart', async () => {
  const seen = [];
  globalThis.fetch = silent(seen);
  await assert.rejects(sendFollowUp(task(), 'reply', { text: 'hello' }, { timeout: 10 }));
  await assert.rejects(sendFollowUp(task(), 'reply', { text: 'hello' }, { timeout: 10 }));
  assert.notEqual(seen[1].body.sendId, seen[0].body.sendId);
});

test('the reply box goes through it: no send of its own without a limit', () => {
  const src = fs.readFileSync(new URL('../web/js/features/composer.js', import.meta.url), 'utf8');
  const box = src.slice(src.indexOf('export async function sendReply'), src.indexOf('// The hold row over the reply box'));
  assert.ok(box.length > 500, 'found sendReply');
  assert.doesNotMatch(box, /api\(`\/sessions\/\$\{id\}\/(reply|answer)`/);
  assert.match(box, /sendFollowUp\(/);
});

// One answer box: questions and approvals are answered in the reply box, the card has none of its own.
test('a typed reply answers the question or approval, in every mode and whatever is picked for the next follow-up', () => {
  const question = { id: 'a1', question: 'Proceed with the fix?', options: ['Yes', 'No'] };
  const approval = { id: 'a2', question: 'Run `npm publish`?', options: ['Allow', 'Always allow', 'Deny'], permission: { tool: 'Bash', detail: 'npm publish', action: 'run `npm publish`' } };
  for (const ask of [question, approval]) assert.equal(answersAsk(ask), true, ask.question);
  // Nothing in it looks at the task's mode or what's picked under the box: Plan, Edits and Full auto alike.
  assert.equal(answersAsk.length, 1);
  assert.equal(answersAsk(question, { attachments: [] }), true);
  // Files can't ride on an answer: that's a follow-up. And with no question, there's nothing to answer.
  assert.equal(answersAsk(question, { attachments: ['up1'] }), false);
  assert.equal(answersAsk(null), false);
  assert.equal(answersAsk(undefined), false);
});

test('the reply box answers through /answer, keeps a picked mode for the next follow-up, and holds nothing', () => {
  const src = fs.readFileSync(new URL('../web/js/features/composer.js', import.meta.url), 'utf8');
  const box = src.slice(src.indexOf('export async function sendReply'), src.indexOf('// The hold row over the reply box'));
  assert.match(box, /const answering = answersAsk\(s\.ask, \{ attachments \}\)/);
  assert.match(box, /answering && !withGoal\s*\?\s*sendFollowUp\(id, 'answer', \{ text \}\)/);
  // An answer never waits on the near-the-limit hold row.
  assert.match(box, /if \(!answering && !confirm\) \{\s*const h = holdNow/);
  // The mode, harness and team picks are only used up by a follow-up.
  assert.match(box, /if \(!answering\) \{\s*S\.replyModes\.delete\(id\);\s*S\.replyRunners\.delete\(id\);\s*S\.replyTeams\.delete\(id\);/);
});

test('a question or approval card has no answer box of its own', () => {
  const src = fs.readFileSync(new URL('../web/js/features/turns.js', import.meta.url), 'utf8');
  const card = src.slice(src.indexOf('function renderAskCard'), src.indexOf('// Under a finished turn.'));
  assert.ok(card.length > 500, 'found renderAskCard');
  assert.doesNotMatch(card, /<form|<input|<textarea|q-own/);
  // Its buttons still answer, optimistically, and roll back with a toast when refused.
  assert.match(card, /startOptimistic\(s\.id, text, null, \{ answering: true \}\)/);
  assert.match(card, /undo\?\.\(\);\s*toastError\(e\);/);
  for (const dir of ['css', 'js']) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(`${d}/${f.name}`) : [`${d}/${f.name}`]));
    for (const f of walk(new URL(`../web/${dir}`, import.meta.url).pathname)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bq-own\b/, f);
  }
});
