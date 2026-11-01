// Goals (server/goal.js): the task keeps going until wisp's check finds the condition holds, can't
// hold, or goes in circles; there's no cap on rounds. The fake harness's checker reads its verdict off the goal's text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const { goalCommand, normalizeGoal, goalNote, goalView, withJudges } = await import('../server/goal.js');

// The server is set up before the first test: a top-level await after a test lets Node run the
// root's after hook before this before hook, and the open server keeps the run from ending.
process.env.FAKE_RECORD = tmp('goal-record');
process.env.WISP_HOME = tmp('goal-home');
process.env.WISP_UPDATE_CHECK = '0';
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
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const landed = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state === 'review' && !['working', 'checking'].includes(x.goal?.status) && x;
}, { timeout: 60_000 });
const summary = async (id) => (await api('/sessions')).find((x) => x.id === id);

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

test('goalCommand and normalizeGoal read what the user typed', () => {
  assert.equal(goalCommand('/goal all tests pass'), 'all tests pass');
  assert.equal(goalCommand('/goal'), '');
  assert.equal(goalCommand('/goals are nice'), null);
  assert.equal(goalCommand('fix it'), null);
  assert.deepEqual(normalizeGoal('tests pass'), { text: 'tests pass' });
  assert.deepEqual(normalizeGoal({ text: ' x ', max: 3 }), { text: 'x' }, "an old client's max is ignored");
  assert.equal(normalizeGoal({ text: '  ' }), null);
  assert.throws(() => normalizeGoal('x'.repeat(1001)), /at most 1000/);
  assert.match(goalNote({ goal: { text: 'it builds', round: 2, status: 'working' } }), /## Goal[\s\S]*it builds[\s\S]*round 2 now/);
  assert.equal(goalNote({ goal: { text: 'x', status: 'met' } }), '');
});

test('not met yet: wisp sends it back with what is missing, until the check says it holds', async () => {
  const s = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 3]' } });
  assert.equal(s.goal.status, 'working');
  assert.equal(s.goal.max, undefined);
  const done = await landed(s.id);
  assert.equal(done.turns.length, 3, 'two rounds sent back');
  assert.equal(done.goal.status, 'met');
  assert.equal(done.goal.round, 3);
  assert.deepEqual(done.goal.checks.map((c) => c.verdict), ['not_yet', 'not_yet', 'met']);
  const back = done.turns[1];
  assert.equal(back.by, 'wisp');
  assert.equal(back.goal, 2);
  assert.match(back.prompt, /isn't met yet[\s\S]*Goal: it works[\s\S]*What's missing: check 1[\s\S]*Next: do part 2/);
  assert.ok(done.turns[2].activity.some((a) => a.kind === 'goal' && /Goal check: met/.test(a.label)));
  const sum = await summary(s.id);
  assert.equal(sum.goal.status, 'met');
  assert.equal(sum.goal.last.verdict, 'met');
  assert.equal(sum.followups, 0, "wisp's rounds aren't your follow-ups");
  // The agent was told about its goal.
  const { records } = await import('./helpers.js');
  assert.ok(records(process.env.FAKE_RECORD, 'claude').some((r) => r.argv.join(' ').includes('## Goal')));
});

test('a goal that cannot be met stops at once, with why', async () => {
  const s = await api('/sessions', { prompt: 'deploy it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'live in prod [impossible]' } });
  const done = await landed(s.id);
  assert.equal(done.turns.length, 1);
  assert.equal(done.goal.status, 'impossible');
  assert.match(done.goal.why, /impossible/);
});

test('no cap on rounds: an old max is ignored and it keeps going until the check says met', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it holds [met after 5]', max: 2 } });
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'met');
  assert.equal(done.goal.round, 5);
  assert.equal(done.turns.length, 5);
});

test('a goal that never holds and gets nowhere pauses as stalled, and Resume carries on', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'never true' } });
  let done = await landed(s.id);
  assert.equal(done.goal.status, 'paused');
  assert.match(done.goal.why, /^Stalled/);
  const n = done.turns.length;
  await api(`/sessions/${s.id}/goal`, { action: 'resume' }, 'PATCH');
  done = await landed(s.id);
  assert.equal(done.goal.status, 'paused');
  assert.ok(done.turns.length > n, 'resumed: more rounds');
});

test('/goal in a follow-up sets one on an idle task and goes after it; /goal drop drops it', async () => {
  const s = await api('/sessions', { prompt: 'look around', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await landed(s.id);
  const r = await api(`/sessions/${s.id}/reply`, { text: '/goal it is tidy [met after 2]' });
  assert.equal(r.goal.text, 'it is tidy [met after 2]');
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'met');
  assert.equal(done.turns.length, 2, 'checked at once: not yet, one round, met');
  await api(`/sessions/${s.id}/reply`, { text: '/goal drop' });
  assert.equal((await api(`/sessions/${s.id}`)).goal, undefined);
  await assert.rejects(api(`/sessions/${s.id}/goal`, {}, 'DELETE'), /no goal/);
});

test('a follow-up with a goal sends the message and checks the goal after that turn, not the one before', async () => {
  const s = await api('/sessions', { prompt: 'look around', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await landed(s.id);
  await api(`/sessions/${s.id}/reply`, { text: 'now tidy it up', goal: { text: 'it is tidy [met after 1]' } });
  const done = await landed(s.id);
  assert.equal(done.turns.length, 2, 'the follow-up ran, and its turn met the goal: no round sent back');
  assert.equal(done.turns[1].prompt, 'now tidy it up');
  assert.equal(done.goal.status, 'met');
  assert.equal(done.goal.checks.length, 1);
  assert.equal(done.goal.checks[0].turnId, done.turns[1].id);
  const { records } = await import('./helpers.js');
  const rs = records(process.env.FAKE_RECORD, 'claude').filter((r) => JSON.stringify(r).includes('now tidy it up'));
  assert.ok(rs.some((r) => JSON.stringify(r).includes('it is tidy')), "the follow-up's run was told the goal");
  await assert.rejects(api(`/sessions/${s.id}/reply`, { text: 'again', goal: { text: 'x'.repeat(1001) } }), /at most 1000/);
});

test('/goal right after a turn lands, while its CLI is still on its way out, is still checked', async () => {
  process.env.FAKE_LINGER = '2000'; // under the 3 s linger, so the run is still live when the goal is set
  try {
    const s = await api('/sessions', { prompt: 'look around', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
    await landed(s.id);
    await api(`/sessions/${s.id}/reply`, { text: '/goal it is neat [met after 1]' });
    const done = await landed(s.id);
    assert.equal(done.goal.status, 'met');
  } finally {
    delete process.env.FAKE_LINGER;
  }
});

test('a launch that is just /goal makes the condition the task; pause lands it after its round', async () => {
  const s = await api('/sessions', { prompt: '/goal the readme is clear', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  assert.equal(s.goal.text, 'the readme is clear');
  assert.equal((await api(`/sessions/${s.id}`)).turns[0].prompt, 'the readme is clear');
  await until(async () => (await api(`/sessions/${s.id}`)).turns.length >= 2, { timeout: 30_000 });
  await api(`/sessions/${s.id}/goal`, { action: 'pause' }, 'PATCH');
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'paused');
  const n = done.turns.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api(`/sessions/${s.id}`)).turns.length, n, 'nothing more after a pause');
  await assert.rejects(api(`/sessions/${s.id}/goal`, { text: '' }, 'PUT'), /Say what has to be true/);
});

test('judges: normalizeGoal reads them and refuses bad ones', () => {
  assert.deepEqual(normalizeGoal({ text: 'x', judges: [{ agent: 'codex', model: 'm', effort: 'high', name: ' Codex ' }, { crew: 'c1' }], vote: 'all' }), { text: 'x', judges: [{ agent: 'codex', model: 'm', effort: 'high', name: 'Codex' }, { crew: 'c1' }], vote: 'all' });
  assert.equal(normalizeGoal({ text: 'x' }).judges, undefined, 'left out: an edit keeps the ones it had');
  assert.deepEqual(normalizeGoal({ text: 'x', judges: [] }).judges, []);
  assert.throws(() => normalizeGoal({ text: 'x', judges: [{ agent: 'nope' }] }), /harness wisp knows/);
  assert.throws(() => normalizeGoal({ text: 'x', judges: Array(6).fill({ agent: 'claude' }) }), /at most 5 judges/);
  assert.throws(() => normalizeGoal({ text: 'x', vote: 'most' }), /vote must be one of all, majority, any/);
});

const JUDGES = [{ agent: 'claude', name: 'Claude' }, { agent: 'codex', name: 'Codex' }, { agent: 'opencode', name: 'opencode' }];
const VOTES = '[judge claude: met] [judge codex: met] [judge opencode: not_yet]';

test('judges: a majority of them saying met meets the goal, each vote is kept', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: `it works ${VOTES}`, judges: JUDGES } });
  assert.equal(s.goal.vote, 'majority', 'majority by default');
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'met');
  assert.equal(done.turns.length, 1);
  const c = done.goal.checks[0];
  assert.equal(c.tally, '2 of 3 judges say met (2 of 3 must agree)');
  assert.equal(c.progress, 100);
  const sum = await summary(s.id);
  assert.deepEqual(sum.goal.last.votes.map((v) => v.verdict), ['met', 'met', 'not_yet'], 'the band gets the last votes');
  assert.equal(sum.goal.checks[0].votes, undefined, "the summary's checks go without their votes");
  assert.deepEqual(c.votes.map((v) => [v.name, v.agent, v.verdict]), [['Claude', 'claude', 'met'], ['Codex', 'codex', 'met'], ['opencode', 'opencode', 'not_yet']]);
  // Each judge ran on its own harness and was told it's one of three.
  const { records } = await import('./helpers.js');
  for (const bin of ['claude', 'codex', 'opencode']) assert.ok(records(process.env.FAKE_RECORD, bin).some((r) => /You are .*one of 3 judges/.test(r.stdin)), bin);
});

test('judges: with All, one dissent keeps it going and says what that judge wants', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: `it works ${VOTES}`, judges: JUDGES, vote: 'all' } });
  const done = await landed(s.id);
  assert.notEqual(done.goal.status, 'met');
  const c = done.goal.checks[0];
  assert.equal(c.verdict, 'not_yet');
  assert.equal(c.tally, '2 of 3 judges say met (all must agree)');
  assert.equal(c.why, 'opencode: check 1: not_yet', "what's missing is the dissenter's reason");
  assert.equal(c.next, 'opencode: do part 2', "only the dissenter's next step");
  assert.match(done.turns[1].prompt, /Judges: 2 of 3 judges say met \(all must agree\)\.\s+What's missing: opencode: check 1/);
});

test('judges: with Any, one met is enough; a majority saying impossible ends it', async () => {
  const any = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'x [judge codex: met] [judge claude: not_yet]', judges: JUDGES.slice(0, 2), vote: 'any' } });
  assert.equal((await landed(any.id)).goal.status, 'met');
  const no = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'x [judge claude: impossible] [judge codex: impossible] [judge opencode: met]', judges: JUDGES, vote: 'all' } });
  assert.equal((await landed(no.id)).goal.status, 'impossible');
});

test('judges: an edit without judges keeps them, [] clears them, a bad vote is refused', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await landed(s.id);
  let r = await api(`/sessions/${s.id}/goal`, { text: 'a [met after 1]', judges: JUDGES.slice(0, 1), vote: 'any' }, 'PUT');
  assert.deepEqual([r.goal.judges.length, r.goal.vote], [1, 'any']);
  await landed(s.id);
  r = await api(`/sessions/${s.id}/goal`, { text: 'b [met after 1]' }, 'PUT');
  assert.deepEqual([r.goal.judges.length, r.goal.vote], [1, 'any']);
  await landed(s.id);
  r = await api(`/sessions/${s.id}/goal`, { text: 'c [met after 1]', judges: [] }, 'PUT');
  assert.equal(r.goal.judges, undefined);
  await landed(s.id);
  await assert.rejects(api(`/sessions/${s.id}/goal`, { text: 'd', vote: 'most' }, 'PUT'), /vote must be one of/);
});

test('judges: a crew member on Auto judges on the pick Auto makes; one that left the crew holds All back and the goal pauses', async () => {
  const cwd = makeRepo();
  const crew = await api('/crew', { name: 'Vera', role: 'Reviewer', cwd, agent: 'auto' });
  const m = crew.member || crew;
  const s = await api('/sessions', { prompt: 'do it', cwd, agent: 'claude', mode: 'edits', goal: { text: 'x [judge claude: met] [judge codex: met] [judge opencode: met]', judges: [{ crew: m.id }, { agent: 'codex' }], vote: 'all' } });
  let done = await landed(s.id);
  assert.equal(done.goal.status, 'met', JSON.stringify(done.goal.checks.at(-1)));
  // A member who's gone: only they hold All back, so there's nothing for the agent to fix.
  const t = await api('/sessions', { prompt: 'do it', cwd, agent: 'claude', mode: 'edits', goal: { text: 'x [judge codex: met]', judges: [{ crew: 'gone', name: 'Ghost' }, { agent: 'codex' }], vote: 'all' } });
  done = await landed(t.id);
  assert.equal(done.goal.status, 'paused');
  assert.equal(done.turns.length, 1, 'no empty round sent back');
  assert.match(done.goal.why, /1 of 2 judges say met \(all must agree\): Ghost left your crew\./);
});

test('judges: changing them sets the old votes aside and starts the stall count over', () => {
  const vote = [{ name: 'Codex', agent: 'codex', verdict: 'met', why: 'ok', next: '', progress: 100 }];
  const g = { text: 'x', round: 2, status: 'working', setAt: 1, checks: [{ round: 1, verdict: 'not_yet', why: 'no', tally: '1 of 2 judges say met', votes: vote, bench: 0, at: 2 }], judges: [{ agent: 'codex' }, { agent: 'claude' }], vote: 'all' };
  assert.deepEqual(goalView(g).last.votes, [{ name: 'Codex', verdict: 'met', why: 'ok' }]);
  assert.equal(goalView(g).checks[0].votes, undefined);
  withJudges(g, g.judges, 'all');
  assert.equal(g.bench, undefined, 'the same judges: nothing changes');
  withJudges(g, [{ agent: 'codex' }], 'all');
  assert.deepEqual([g.bench, g.fresh], [1, 1]);
  assert.equal(goalView(g).last.votes, undefined, "the old bench's votes aren't shown");
  withJudges(g, [{ agent: 'codex' }], 'any');
  assert.equal(g.bench, 2, 'another rule is a change too');
});
