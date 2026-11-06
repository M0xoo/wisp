// A run that fails because its harness is signed out (server/agent-login.js signedOutBy, runner
// #signedOut): the turn says so, the card signs in where you are, and the request goes again once,
// in the same conversation, only when the card asked for that.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, sleep, taskRuns, tmp, until } from './helpers.js';
import { haltOf, STATUS_LABEL } from '../web/js/core/format.js';

const record = tmp('sign-in-record');
Object.assign(process.env, { WISP_HOME: tmp('sign-in-wisp'), WISP_UPDATE_CHECK: '0', WISP_TELEMETRY: '0', CLAUDE_CONFIG_DIR: tmp('sign-in-claude'), CODEX_HOME: tmp('sign-in-codex'), XDG_DATA_HOME: tmp('sign-in-data'), FAKE_RECORD: record });
installFakeBins();

const { signedOutBy } = await import('../server/agent-login.js');
const { startServer } = await import('../server/index.js');
const { Pipeline } = await import('../server/pipeline.js');

let srv;
let base;
let shared;
const repo = () => (shared ??= makeRepo()); // tasks here don't touch it, and git is what's slow
before(async () => {
  const port = await new Promise((resolve) => {
    const n = net.createServer();
    n.listen(0, () => {
      const { port: free } = n.address();
      n.close(() => resolve(free));
    });
  });
  srv = await startServer({ port, handleSignals: false });
  base = `${srv.url}/api`;
  realStatus = srv.runner.authStatus;
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});
afterEach(() => {
  for (const k of ['FAKE_FAIL', 'FAKE_SIGNED_OUT']) delete process.env[k];
  srv.guard.check = srv.guard.constructor.prototype.check;
});

const api = async (p, method = 'GET', body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const settled = (id) => until(() => srv.store.get(id)?.state !== 'running' && !srv.runner.live.has(id) && srv.store.get(id), { what: 'the run to end' });
// A task whose first run is signed out; later runs work.
async function signedOut({ agent = 'claude', ...more } = {}) {
  process.env.FAKE_SIGNED_OUT = path.join(tmp('sign-in-once'), 'hit');
  const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent, ...more });
  const s = await settled(json.id);
  return { s, turn: s.turns.at(-1) };
}
let realStatus;
const block = (t, type) => t.presentation.blocks.find((b) => b.type === type);
const nextRun = async (s, n = 2) => until(() => s.turns.length === n && s.turns.at(-1).status === 'done' && !srv.runner.live.has(s.id), { what: 'the rerun' });
// Long enough that a second, wrong run would have shown up.
const quiet = () => sleep(300);

test('every harness’s real words read as signed out, and ordinary failures don’t', () => {
  const out = [
    ['claude', 'Not logged in · Please run /login'],
    ['claude', 'Login expired · Please run /login'],
    ['claude', 'OAuth token revoked · Please run /login'],
    ['claude', 'Login reached its time limit · Please run /login'],
    ['claude', 'Authentication required · Sign in again to continue'],
    ['claude', 'Failed to authenticate: OAuth session expired and could not be refreshed'],
    ['claude', 'Session expired. Please run /login to sign in again.'],
    ['claude', 'API Error: 401 Invalid API key · Please run /login'],
    ['codex', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'],
    ['codex', 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.'],
    ['codex', 'Your access token could not be refreshed. Please sign in again.'],
    ['codex', 'no Codex credentials were found'],
    ['codex', 'Run codex login to continue'],
    ['cursor', "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."],
    ['grok', 'Not signed in. To authenticate without a browser, run:\n  grok login --device-code'],
    ['grok', 'Session expired. Run `grok login` to re-authenticate.'],
    ['grok', 'Authentication required. Run `grok login` to re-authenticate.'],
    ['grok', 'Run /login to re-authenticate'],
    ['antigravity', 'authentication failed or timed out'],
    ['antigravity', "Error: authentication required. Run 'agy' to log in, then retry."],
    ['opencode', 'Upstream request failed: Invalid credential'],
  ];
  for (const [agent, text] of out) assert.equal(signedOutBy(agent, text), true, `${agent}: ${text}`);
  const not = [
    ['claude', 'Invalid API key · Fix external API key'], // a key in the env: signing in doesn't help
    ['claude', 'fake: something broke (500)'],
    ['claude', `The tests failed.\nnot logged in\n${'x'.repeat(1300)}`.replace('not logged in', 'Not logged in')], // a long run quoting it
    ['codex', 'unexpected status 500 Internal Server Error'],
    ['grok', 'Session expired (HTTP 404)'],
    ['opencode', 'Unexpected server error'], // no key at all: can't be told apart
    ['copilot', 'Not logged in · Please run /login'], // no sign-in here
    ['gh', 'Not logged in · Please run /login'],
    ['nope', 'Not logged in'],
    ['claude', undefined],
  ];
  for (const [agent, text] of not) assert.equal(signedOutBy(agent, text), false, `${agent}: ${String(text).slice(0, 40)}`);
  const quoted = `Not logged in · Please run /login\n${'y'.repeat(1200)}`;
  assert.equal(signedOutBy('claude', quoted), false);
});

test('a signed-out run: the hero says so, the raw line stays, and it reads Signed out', async () => {
  const { s, turn } = await signedOut();
  assert.deepEqual(turn.signedOut, { agent: 'claude', account: turn.account || '', scope: '', others: [] });
  assert.equal(turn.status, 'error');
  const hero = block(turn, 'hero');
  assert.equal(hero.title, 'Claude Code is signed out');
  assert.equal(hero.summary, 'Sign in and wisp sends your request again, in this same conversation.');
  assert.equal(hero.status, 'blocked');
  assert.equal(block(turn, 'terminal').output, 'Not logged in · Please run /login');
  assert.equal(block(turn, 'next'), undefined);
  assert.equal(haltOf(turn), 'signedOut');
  assert.equal(STATUS_LABEL.signedOut, 'Signed out');
  assert.equal((await api('/sessions')).json.find((x) => x.id === s.id).halt, 'signedOut');
});

test('a normal failure is still <name> failed, with Try again', async () => {
  process.env.FAKE_FAIL = '1';
  const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'claude' });
  const turn = (await settled(json.id)).turns.at(-1);
  assert.equal(turn.signedOut, undefined);
  assert.equal(block(turn, 'hero').title, 'Claude Code failed');
  assert.equal(block(turn, 'next').items[0], 'Try again');
});

test('signed in from the card: the request goes once, in the same conversation', async () => {
  const { s, turn } = await signedOut();
  const conversation = s.agentSessionId;
  assert.ok(conversation);
  const before = taskRuns(record, 'claude').length;
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {})).json, { armed: true });
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {})).json, { armed: true }, 'again is the same');
  await Promise.all([srv.runner.signInDone('claude', ''), srv.runner.signInDone('claude', 'default')]);
  await nextRun(s);
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {})).json, { rerun: false });
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {})).json, { rerun: false });
  await srv.runner.signInDone('claude', '');
  await quiet();
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns.at(-1).prompt, 'Fix the bug');
  assert.ok(turn.signedOut.rerun);
  assert.equal(s.agentSessionId, conversation);
  const runs = taskRuns(record, 'claude');
  assert.equal(runs.length, before + 1);
  assert.equal(runs.at(-1).argv[runs.at(-1).argv.indexOf('--resume') + 1], conversation);
});

test('Try again sends it once; two clicks are one run, and the second is quiet', async () => {
  const { s, turn } = await signedOut();
  const [a, b] = await Promise.all([api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {}), api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {})]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.json.rerun, b.json.rerun].sort(), [false, true]);
  await nextRun(s);
  await quiet();
  assert.equal(s.turns.length, 2);
});

test('the only-once mark is on the turn, so a restart can’t send it twice', async () => {
  const { s, turn } = await signedOut();
  await srv.runner.rerunSignedOut(s, turn.id);
  await nextRun(s);
  assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'sessions', `${s.id}.json`), 'utf8')).turns[0].signedOut.rerun);
});

test('no rerun over a newer turn, a running task or a queue', async () => {
  const { s, turn } = await signedOut();
  await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {});
  await api(`/sessions/${s.id}/reply`, 'POST', { text: 'Something else' });
  await nextRun(s);
  await srv.runner.signInDone('claude', '');
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {})).json, { rerun: false });
  await quiet();
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns.at(-1).prompt, 'Something else');

  const b = await signedOut();
  b.s.queue.push({ id: 'q', text: 'waiting', attachments: [] });
  assert.deepEqual(await srv.runner.rerunSignedOut(b.s, b.turn.id), { rerun: false });
  b.s.queue.length = 0;
  b.s.state = 'running';
  assert.deepEqual(await srv.runner.rerunSignedOut(b.s, b.turn.id), { rerun: false });
  b.s.state = 'review';
  assert.equal(b.turn.signedOut.rerun, undefined, 'nothing went: Try again still can');
  assert.equal(b.s.turns.length, 1);
});

test('a task filed while the sign-in ran isn’t brought back by it, and Try again still can', async () => {
  for (const file of [{ state: 'done' }, { archived: true }]) {
    const { s, turn } = await signedOut();
    await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {});
    Object.assign(s, file);
    await srv.runner.signInDone('claude', '');
    await quiet();
    assert.equal(s.turns.length, 1);
    assert.equal(turn.signedOut.rerun, undefined);
  }
});

test('a sign-in nothing armed runs nothing, a cancelled one forgets, and another account’s doesn’t count', async () => {
  const { s, turn } = await signedOut();
  await srv.runner.signInDone('claude', '');
  await quiet();
  assert.equal(s.turns.length, 1, 'Settings or a terminal: the card offers Try again');

  await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {});
  await srv.runner.signInDone('codex', '');
  await srv.runner.signInDone('claude', 'work');
  await quiet();
  assert.equal(s.turns.length, 1);

  srv.runner.disarmSignIn('claude', 'default'); // the same as ''
  await srv.runner.signInDone('claude', '');
  await quiet();
  assert.equal(s.turns.length, 1);

  await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {});
  await srv.runner.signInDone('claude', '', { skip: () => true }); // open in a terminal
  await quiet();
  assert.equal(s.turns.length, 1);
  assert.equal(srv.runner.signIns.size, 0);
});

test('a turn wisp sent, or a turn a side discussion ran, says Try again and doesn’t arm', async () => {
  const { s, turn } = await signedOut();
  turn.by = 'wisp';
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {})).json, { armed: false });
  delete turn.by;
  turn.plain = true;
  assert.equal(srv.runner.armSignIn(s, turn.id), false);
  delete turn.plain;
  assert.equal(srv.runner.armSignIn(s, 'nope'), false);
  assert.equal(srv.runner.armSignIn({ ...s, parentId: 'lead' }, turn.id), false);
  assert.equal(srv.runner.armSignIn({ ...s, delegated: { lead: 'x' } }, turn.id), false);
  assert.equal(srv.runner.armSignIn({ ...s, sideOf: { id: 'x' } }, turn.id), false);
  assert.equal(srv.runner.signIns.size, 0);

  process.env.FAKE_SIGNED_OUT = '1';
  const plain = srv.store.config.defaults.blocks;
  srv.store.config.defaults.blocks = 'off';
  try {
    const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'claude' });
    assert.equal(block((await settled(json.id)).turns.at(-1), 'hero').summary, 'Sign in, then Try again.');
  } finally {
    srv.store.config.defaults.blocks = plain;
  }
});

test('a subagent’s failure goes to its lead as it is', async () => {
  process.env.FAKE_SIGNED_OUT = '1';
  const dir = repo();
  const child = srv.runner.create({ prompt: 'Help', cwd: dir, agent: 'claude', parentId: 'lead-1' });
  await settled(child.id);
  assert.equal(child.turns.at(-1).signedOut, undefined);
  assert.equal(block(child.turns.at(-1), 'hero').title, 'Claude Code failed');
});

test('Auto leaves a signed-out turn alone', () => {
  const p = new Pipeline({ settings: () => ({ escalate: true }) });
  const session = { auto: { strategy: 'best2' }, mode: 'auto' };
  const ev = { isError: true, text: 'Not logged in · Please run /login' };
  assert.equal(p.wants(session, { signedOut: { agent: 'claude' } }, ev), false);
  assert.equal(p.wants(session, {}, { isError: true, text: 'rate limit exceeded' }), true, 'a limit still moves on');
});

test('Continue on: only an account the card offered; another is 400 and doesn’t mark the turn', async () => {
  const { s, turn } = await signedOut();
  assert.equal((await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', { account: 'nope' })).status, 400);
  assert.equal(turn.signedOut.rerun, undefined);
  turn.signedOut.others = [{ id: 'k3f9', label: 'Personal', kind: 'personal' }];
  const asked = [];
  const reply = srv.runner.reply;
  srv.runner.reply = (...a) => (asked.push(a), { queued: false });
  try {
    assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', { account: 'k3f9' })).json, { rerun: true });
  } finally {
    srv.runner.reply = reply;
  }
  assert.deepEqual(asked[0][3].run, { account: 'k3f9' });
});

test('others: your other ready accounts, only with several', async () => {
  const accounts = srv.runner.accounts;
  srv.runner.accounts = { multi: () => true, list: () => [{ id: 'default', label: 'Work', kind: 'work', state: 'ready' }, { id: 'k3f9', label: 'Personal', kind: 'personal', state: 'ready', email: 'a@b' }, { id: 'zz', label: 'Old', kind: 'personal', state: 'signedOut' }], pick: accounts.pick?.bind(accounts) };
  try {
    const { turn } = await signedOut();
    assert.deepEqual(turn.signedOut.others, [{ id: 'k3f9', label: 'Personal', kind: 'personal' }]);
  } finally {
    srv.runner.accounts = accounts;
  }
});

test('near your line, the rerun is held like a scheduled follow-up', async () => {
  const { s, turn } = await signedOut();
  srv.guard.check = () => ({ agent: 'claude', used: 0.95, line: 0.9 });
  assert.deepEqual(await srv.runner.rerunSignedOut(s, turn.id), { rerun: true });
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns.at(-1).status, 'held');
  assert.equal(s.turns.at(-1).prompt, 'Fix the bug');
  assert.ok(turn.signedOut.rerun);
});

test('attachments go along, with their file', async () => {
  const dir = repo();
  const up = await (await fetch(`${base}/uploads?name=notes.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'notes.txt' }, body: 'hello' })).json();
  process.env.FAKE_SIGNED_OUT = path.join(tmp('sign-in-once'), 'hit');
  const { json } = await api('/sessions', 'POST', { prompt: 'Read the notes', cwd: dir, worktree: false, agent: 'claude', attachments: [up.id] });
  const s = await settled(json.id);
  const turn = s.turns.at(-1);
  assert.equal(turn.attachments[0].id, up.id);
  assert.equal(turn.attachments[0].path, undefined, 'a turn keeps no path');
  await api(`/sessions/${s.id}/turns/${turn.id}/rerun`, 'POST', {});
  await nextRun(s);
  assert.equal(s.turns.at(-1).attachments[0].id, up.id);
  const said = taskRuns(record, 'claude').at(-1);
  assert.match(JSON.stringify(said), /notes\.txt/);
});

test('a worktree an idle task lost comes back before the rerun', async () => {
  const { s, turn } = await signedOut();
  let ready = 0;
  const was = srv.runner.readyToRun;
  srv.runner.readyToRun = async () => void ready++;
  await srv.runner.rerunSignedOut(s, turn.id);
  srv.runner.readyToRun = was;
  assert.equal(ready, 1);
  await nextRun(s);

  const b = await signedOut();
  srv.runner.readyToRun = async () => {
    throw new Error('no folder');
  };
  await assert.rejects(srv.runner.rerunSignedOut(b.s, b.turn.id), /no folder/);
  srv.runner.readyToRun = was;
  assert.equal(b.turn.signedOut.rerun, undefined, 'it never went: the card can again');
});

test('a key saved from the card: opencode’s rerun, through the real route', async () => {
  process.env.FAKE_FAIL = '1'; // opencode: `fake: not logged in (401)`
  const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'opencode' });
  const s = await settled(json.id);
  const turn = s.turns.at(-1);
  assert.ok(turn.signedOut);
  assert.equal(block(turn, 'hero').title, 'opencode is signed out');
  assert.equal(block(turn, 'hero').summary, 'Add your API key and wisp sends your request again, in this same conversation.');
  delete process.env.FAKE_FAIL;
  assert.deepEqual((await api(`/sessions/${s.id}/turns/${turn.id}/sign-in`, 'POST', {})).json, { armed: true });
  assert.equal((await api('/agents/opencode/keys', 'POST', { provider: 'opencode', key: 'sk-test' })).status, 200);
  await nextRun(s);
  assert.equal(s.turns.length, 2);
});

test('a task on a machine: both routes go through to its wisp', async () => {
  const calls = [];
  const json = srv.machines.json;
  srv.machines.json = async (mid, method, p, body) => (calls.push([mid, method, p, body]), { armed: true });
  try {
    assert.deepEqual((await api('/sessions/abc@m1/turns/t1/sign-in', 'POST', {})).json, { armed: true });
    await api('/sessions/abc@m1/turns/t1/rerun', 'POST', { account: 'k3f9' });
  } finally {
    srv.machines.json = json;
  }
  assert.deepEqual(calls, [
    ['m1', 'POST', '/sessions/abc/turns/t1/sign-in', {}],
    ['m1', 'POST', '/sessions/abc/turns/t1/rerun', { account: 'k3f9' }],
  ]);
});

// A recorded stream, as the CLI writes it.
const replay = (lines) => {
  const f = path.join(tmp('sign-in-replay'), 'run.jsonl');
  fs.writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return f;
};
const replayed = async (lines) => {
  process.env.FAKE_REPLAY = replay(lines);
  try {
    const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'claude' });
    return (await settled(json.id)).turns.at(-1);
  } finally {
    delete process.env.FAKE_REPLAY;
  }
};
const init = { type: 'system', subtype: 'init', session_id: 'replay-1' };
const said = (text, more = {}) => ({ type: 'assistant', session_id: 'replay-1', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...more });
const result = (text, more) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'replay-1', num_turns: 1, ...more });

test('a failed sign-in without is_error is still an error, with the card', async () => {
  const quoted = await replayed([init, result('Not logged in · Please run /login', { duration_api_ms: 0 })]);
  assert.equal(quoted.status, 'error');
  assert.ok(quoted.signedOut);
  const flagged = await replayed([init, said('Your login has lapsed.', { error: 'authentication_failed' }), result('', { duration_api_ms: 0 })]);
  assert.equal(flagged.status, 'error');
  assert.ok(flagged.signedOut, 'the structured code alone is enough');
  assert.equal(block(flagged, 'terminal').output, 'Your login has lapsed.', 'the words it said, when the result has none');
  const real = await replayed([init, said('Not logged in · Please run /login', { error: 'authentication_failed' }), result('Not logged in · Please run /login', { is_error: true, duration_api_ms: 0 })]);
  assert.ok(real.signedOut, 'as it really arrives');
});

test('an agent’s answer stays done, whatever it says, when a model answered', async () => {
  const answer = await replayed([init, said('Not logged in'), result('Not logged in', { duration_api_ms: 1200 })]);
  assert.equal(answer.status, 'done');
  assert.equal(answer.signedOut, undefined);
  const flagged = await replayed([init, said('hm', { error: 'authentication_failed' }), result('All fixed.', { duration_api_ms: 900 })]);
  assert.equal(flagged.status, 'done', 'a real API duration wins over the flag');
  const unknown = await replayed([init, said('Not logged in'), result('Not logged in')]);
  assert.equal(unknown.status, 'done', 'no duration at all: the words alone never count');
});

test('the regexes know the structured codes', () => {
  assert.equal(signedOutBy('claude', 'authentication_failed'), true);
  assert.equal(signedOutBy('codex', '{"code":"refresh_token_invalidated"}'), true);
});

const askedCli = async (agent, answer) => {
  const asked = [];
  srv.runner.authStatus = async (...a) => {
    asked.push(a);
    return answer();
  };
  try {
    let id;
    if (agent === 'codex') {
      process.env.FAKE_LIMIT_ONCE = path.join(tmp('sign-in-codex-401'), 'hit');
      process.env.FAKE_LIMIT_TEXT = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header';
      id = (await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'codex' })).json.id;
    } else {
      process.env.FAKE_SIGNED_OUT = path.join(tmp('sign-in-once'), 'hit');
      id = (await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent })).json.id;
    }
    const s = await settled(id);
    await quiet();
    return { s, turn: s.turns.at(-1), asked };
  } finally {
    for (const k of ['FAKE_LIMIT_ONCE', 'FAKE_LIMIT_TEXT']) delete process.env[k];
    srv.runner.authStatus = realStatus;
  }
};

test('the CLI says it’s signed in: Codex is refusing, Claude had a hiccup, the raw line stays', async () => {
  const codex = await askedCli('codex', () => ({ signedIn: true }));
  assert.equal(codex.asked.length, 1, 'asked once');
  assert.equal(codex.turn.signedOut.stillIn, true);
  assert.equal(block(codex.turn, 'hero').title, 'Codex is refusing requests');
  assert.match(block(codex.turn, 'hero').summary, /answered 401, so signing in again is unlikely to help/);
  assert.match(block(codex.turn, 'terminal').output, /401 Unauthorized/);
  assert.equal(haltOf(codex.turn), 'failed');
  assert.equal((await api('/sessions')).json.find((x) => x.id === codex.s.id).halt, 'failed');

  const claude = await askedCli('claude', () => ({ signedIn: true }));
  assert.equal(claude.asked.length, 1);
  assert.deepEqual(claude.asked[0], ['claude', claude.turn.account || '']);
  assert.equal(block(claude.turn, 'hero').title, 'Claude Code couldn’t use its sign-in');
  assert.equal(block(claude.turn, 'hero').summary, 'It says it’s signed in now, so this may have been a hiccup. Try again.');
  assert.equal(block(claude.turn, 'terminal').output, 'Not logged in · Please run /login');
  assert.equal(srv.runner.armSignIn(claude.s, claude.turn.id), true, 'Sign in again still works');
  srv.runner.disarmSignIn('claude', '');
  const hero = block(claude.turn, 'hero').title;
  await srv.runner.rerunSignedOut(claude.s, claude.turn.id);
  await nextRun(claude.s);
  assert.equal(claude.turn.signedOut.stillIn, true);
  assert.equal(block(claude.turn, 'hero').title, hero);
});

test('no answer, signed out, or a throw leave the card as it is', async () => {
  for (const answer of [() => ({ signedIn: false }), () => ({ signedIn: null }), () => null, () => { throw new Error('no status'); }]) {
    const { turn, asked } = await askedCli('claude', answer);
    assert.equal(asked.length, 1);
    assert.equal(turn.signedOut.stillIn, undefined);
    assert.equal(block(turn, 'hero').title, 'Claude Code is signed out');
    assert.equal(haltOf(turn), 'signedOut');
  }
});

test('a slow answer doesn’t touch a turn that moved on', async () => {
  let answer;
  srv.runner.authStatus = () => new Promise((r) => (answer = r));
  process.env.FAKE_SIGNED_OUT = path.join(tmp('sign-in-once'), 'hit');
  const { json } = await api('/sessions', 'POST', { prompt: 'Fix the bug', cwd: repo(), worktree: false, agent: 'claude' });
  const s = await settled(json.id);
  srv.runner.authStatus = realStatus;
  const turn = s.turns.at(-1);
  await api(`/sessions/${s.id}/reply`, 'POST', { text: 'Something else' });
  await nextRun(s);
  answer({ signedIn: true });
  await quiet();
  assert.equal(turn.signedOut.stillIn, undefined);
  assert.equal(block(turn, 'hero').title, 'Claude Code is signed out');
});

test('Claude Code before 2.1.318: the turn says signing in may stop other tasks', async () => {
  process.env.FAKE_CLI_VERSION = '2.1.300';
  try {
    const { turn } = await signedOut();
    assert.equal(turn.signedOut.oldCli, true);
    process.env.FAKE_CLI_VERSION = '2.1.318';
    assert.equal((await signedOut()).turn.signedOut.oldCli, undefined);
    process.env.FAKE_CLI_VERSION = '2.1.1000';
    assert.equal((await signedOut()).turn.signedOut.oldCli, undefined);
  } finally {
    delete process.env.FAKE_CLI_VERSION;
  }
});
