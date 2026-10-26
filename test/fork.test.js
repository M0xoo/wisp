// Forking a task (server/services/fork.js) through a real wisp server: the fork gets the turns up
// to the one it was forked from, a worktree of its own with the work as it stood then, and a link
// both ways; its harness hears what happened before the fork (server/handoff.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, same, tmp, until } from './helpers.js';

const RECORD = tmp('fork-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('fork-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { missedTurns } = await import('../server/handoff.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function call(p, body) {
  const r = await fetch(`${base}/api${p}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
async function api(p, body) {
  const { status, json } = await call(p, body);
  if (status >= 400) throw new Error(`${p}: ${json.error}`);
  return json;
}
const settled = (id, n) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === n && x.state === 'review' && x;
  });
const last = (bin) => records(RECORD, bin).filter((r) => !r.stdin.startsWith('# wisp retro')).at(-1);
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('a fork carries on from a turn in a copy of the work, on its own branch, linked both ways', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'edits', worktree: true });
  let orig = await settled(s.id, 1);
  const wt = orig.worktree.path;
  fs.appendFileSync(path.join(wt, 'math.js'), '// after one\n'); // what turn 2 finds when it starts
  fs.writeFileSync(path.join(wt, 'new-one.txt'), 'made after turn one\n'); // untracked: a checkpoint keeps its name only
  await api(`/sessions/${s.id}/reply`, { text: 'and tidy up' });
  orig = await settled(s.id, 2);
  fs.appendFileSync(path.join(wt, 'math.js'), '// after two\n');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'untracked\n');

  // From the latest turn, on another harness: everything as it is now, untracked files too.
  const f = await api(`/sessions/${s.id}/fork`, { prompt: 'try it with a lookup table', agent: 'codex' });
  assert.deepEqual(f.forkedFrom, { id: s.id, title: orig.title, turn: 2, of: 2 });
  let fork = await settled(f.id, 3);
  assert.deepEqual(fork.turns.map((t) => !!t.forked), [true, true, false]);
  assert.equal(fork.turns[0].checkpoint, null, 'the original’s checkpoints stay with it');
  assert.notEqual(fork.worktree.path, wt);
  assert.notEqual(fork.worktree.branch, orig.worktree.branch);
  assert.deepEqual([fork.worktree.base, fork.worktree.baseRef], [orig.worktree.base, orig.worktree.baseRef], 'ships against the same base');
  assert.ok(same(fork.worktree.root, orig.worktree.root));
  assert.match(read(fork.worktree.path, 'math.js'), /a \+ b[\s\S]*after one[\s\S]*after two/);
  assert.equal(read(fork.worktree.path, 'scratch.txt'), 'untracked\n');
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: fork.worktree.path, encoding: 'utf8' }), /M math\.js[\s\S]*\?\? scratch\.txt/, 'the work comes back uncommitted');
  assert.match(read(wt, 'math.js'), /after two/, 'the original’s folder is untouched');
  const codex = last('codex');
  assert.ok(same(codex.cwd, fork.worktree.path));
  assert.match(codex.stdin, /This task is a fork of another one \(“[^”]+”\), made from its turn 2 of 2/);
  assert.match(codex.stdin, /fix add\(\) please[\s\S]*and tidy up/);
  assert.match(codex.stdin, /## Follow-up\n\ntry it with a lookup table/);
  orig = await api(`/sessions/${s.id}`);
  assert.deepEqual(orig.forks, [f.id]);
  assert.deepEqual((await api('/sessions')).find((x) => x.id === s.id).forks, [f.id]);

  // Its own follow-ups resume its own conversation: nothing to hand over again.
  await api(`/sessions/${f.id}/reply`, { text: 'one more' });
  fork = await settled(f.id, 4);
  assert.doesNotMatch(last('codex').stdin, /Earlier in this task/);

  // From an earlier turn: the work as the next turn found it, and only the turns up to there.
  const g = await api(`/sessions/${s.id}/fork`, { prompt: 'go another way from the fix', turnId: orig.turns[0].id });
  const early = await settled(g.id, 2);
  assert.equal(early.agent, 'claude', 'the same harness unless you pick another');
  assert.equal(early.forkedFrom.turn, 1);
  assert.equal(early.turns[0].prompt, 'fix add() please');
  const m = read(early.worktree.path, 'math.js');
  assert.match(m, /after one/);
  assert.doesNotMatch(m, /after two/);
  assert.ok(!fs.existsSync(path.join(early.worktree.path, 'scratch.txt')));
  assert.equal(read(early.worktree.path, 'new-one.txt'), 'made after turn one\n', 'new files then come along');
  assert.ok(!last('claude').argv.includes('--resume'), 'a conversation of its own');
  assert.match(last('claude').stdin, /made from its turn 1 of 2/);
  assert.deepEqual((await api(`/sessions/${s.id}`)).forks, [f.id, g.id]);
});

test('a fork needs a request and a finished turn; the tour, unknown turns and harnesses are refused', async () => {
  const s = await api('/sessions', { prompt: 'look around', cwd: makeRepo(), agent: 'claude', worktree: false });
  const orig = await settled(s.id, 1);
  assert.equal((await call(`/sessions/${s.id}/fork`, { prompt: '  ' })).status, 400);
  assert.equal((await call(`/sessions/${s.id}/fork`, { prompt: 'x', turnId: 'nope' })).status, 404);
  assert.equal((await call(`/sessions/${s.id}/fork`, { prompt: 'x', agent: 'nope' })).status, 400);
  assert.equal((await call(`/sessions/${s.id}/fork`, { prompt: 'x', mode: 'yolo' })).status, 400);
  assert.equal((await call('/sessions/nope/fork', { prompt: 'x' })).status, 404);
  const plain = tmp('plain');
  const p = await api('/sessions', { prompt: 'no git here', cwd: plain, agent: 'claude' });
  await settled(p.id, 1);
  assert.equal((await call(`/sessions/${p.id}/fork`, { prompt: 'x' })).status, 409, 'outside git there is nowhere to copy the work');
  // A task in the folder itself (no worktree) forks into a worktree of its own.
  const f = await api(`/sessions/${s.id}/fork`, { prompt: 'fork me', turnId: orig.turns[0].id });
  const fork = await settled(f.id, 2);
  assert.ok(fork.worktree && !same(fork.worktree.path, orig.cwd));
  assert.match(read(fork.worktree.path, 'math.js'), /a \+ b/);
});

test('missedTurns: a fork’s first turns are new to every harness, its own ones are not', () => {
  const s = { forkedFrom: { id: 'x', title: 'T', turn: 1, of: 1 }, turns: [{ id: 'a', agent: 'claude', forked: true }, { id: 'b', agent: 'claude' }, { id: 'c', agent: 'claude' }] };
  assert.deepEqual(missedTurns({ turns: s.turns.slice(0, 2) }, 'claude', null).map((t) => t.id), ['a']);
  assert.deepEqual(missedTurns(s, 'claude', 'sid').map((t) => t.id), [], 'resumes past its own turn b');
});
