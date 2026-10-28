// Subagents through a real wisp server: a lead on one harness delegates over the injected MCP
// server to a team on other harnesses → child sessions run in the lead's folder → the reports
// come back to the lead, and the lead's record carries the delegations, edits and child sessions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('sub-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('sub-home');
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

async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const settled = (id) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.state === 'review' && x;
  });

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

const TEAM = [
  { agent: 'codex', effort: 'high', use: 'image stuff' },
  { name: 'Researcher', agent: 'opencode', model: 'fake/model-a', use: 'research' },
];

for (const lead of ['claude', 'codex', 'opencode', 'grok', 'copilot']) {
  test(`${lead} lead delegates to codex and opencode subagents and gets their reports`, async () => {
    const cwd = makeRepo();
    const s = await api('/sessions', { prompt: 'DELEGATE the review', cwd, agent: lead, worktree: false, subagents: TEAM });
    assert.deepEqual(s.team.map((m) => [m.name, m.agent, m.used]), [['codex', 'codex', false], ['researcher', 'opencode', false]]);
    const done = await settled(s.id);
    const turn = done.turns[0];

    // The lead heard about the team, with the user's "use it for" notes.
    const leadRun = records(RECORD, lead).find((r) => (r.stdin + r.argv.join(' ')).includes('DELEGATE the review'));
    const told = leadRun.argv.join(' ') + leadRun.stdin;
    assert.match(told, /## Subagents/);
    assert.match(told, /`codex`: Codex · default model · high thinking\. Use it for: image stuff/);
    assert.match(told, /`researcher`: opencode · fake\/model-a\. Use it for: research/);
    // ...and to use it instead of its harness's own subagents, which are switched off.
    assert.match(told, /use `delegate` instead: don't use built-in subagents/);
    if (lead === 'claude') assert.deepEqual(leadRun.argv.slice(leadRun.argv.indexOf('--disallowedTools') + 1, -1), ['Task', 'Agent', 'Workflow']);
    if (lead === 'opencode') assert.equal(JSON.parse(leadRun.opencodeConfig).permission.task, 'deny');
    if (lead === 'copilot') assert.ok(leadRun.argv.includes('--excluded-tools=task'));

    // One delegation per member, in this turn, each its own hidden child session.
    assert.deepEqual(turn.delegations.map((d) => d.name), ['codex', 'researcher']);
    assert.match(turn.presentation.blocks[0].summary, /### codex ### researcher/);
    assert.deepEqual(Object.keys(done.children).sort(), ['codex', 'researcher']);
    const kids = Object.values(done.childSessions);
    assert.equal(kids.length, 2);
    for (const k of kids) {
      assert.equal(k.parentId, s.id);
      assert.equal(k.turns[0].status, 'done');
      assert.equal(k.cwd, cwd);
    }
    assert.ok(turn.activity.some((a) => a.label === 'Delegated to codex, researcher'));
    // The codex subagent's new file shows up in the lead's changes, credited to it.
    const notes = turn.changes.find((c) => c.file === 'notes.txt');
    assert.ok(notes?.by?.includes('codex'), 'subagent edit credited on the lead turn');

    // Subagents: their own protocol (no ask_user, no team), and the picked model and level.
    const sub = records(RECORD, 'opencode').filter((r) => r.stdin.includes('Check math.js for researcher')).at(-1);
    assert.match(sub.stdin, /You are a subagent/);
    assert.doesNotMatch(sub.stdin, /## Subagents/);
    assert.ok(sub.argv.includes('fake/model-a'));
    const cx = records(RECORD, 'codex').filter((r) => r.stdin.includes('Check math.js for codex')).at(-1);
    assert.ok(cx.argv.includes('model_reasoning_effort="high"'));
    assert.ok(!cx.argv.some((a) => a.startsWith('mcp_servers.wisp')), 'no MCP server for a subagent');

    // Hidden from the feed unless asked for.
    const list = await api('/sessions');
    assert.ok(!list.some((x) => x.parentId));
    assert.ok((await api('/sessions?children=1')).some((x) => x.parentId === s.id));
  });
}

test('a member with copies runs several tasks at once, one per copy', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE TWICE', cwd: makeRepo(), agent: 'claude', worktree: false, subagents: [{ agent: 'codex', effort: 'high', count: 3, use: 'tests' }] });
  assert.deepEqual(s.team.map((m) => m.name), ['codex#1', 'codex#2', 'codex#3']);
  const done = await settled(s.id);
  const turn = done.turns[0];
  // Two tasks for "codex" in one call land on two different copies, each its own session.
  assert.deepEqual(turn.delegations.map((d) => [d.name, d.member]), [['codex#1', 'codex'], ['codex#2', 'codex']]);
  assert.equal(new Set(turn.delegations.map((d) => d.sessionId)).size, 2);
  assert.match(turn.presentation.blocks[0].summary, /### codex#1 ### codex#2/);
  const told = records(RECORD, 'claude').find((r) => r.stdin.includes('DELEGATE TWICE')).argv.join(' ');
  assert.match(told, /`codex` ×3 \(copies `codex#1`, `codex#2`, `codex#3`\): Codex · default model · high thinking\. Use it for: tests/);
  assert.match(told, /name a copy \(`codex#2`\)/);
  const summary = (await api('/sessions')).find((x) => x.id === s.id);
  assert.deepEqual(summary.team.map((m) => m.used), [true, true, false]);
  await assert.rejects(api('/sessions', { prompt: 'x', cwd: makeRepo(), agent: 'claude', worktree: false, subagents: [{ agent: 'codex', count: 5 }, { agent: 'opencode', count: 5 }, { agent: 'claude', count: 5 }] }), /At most 12 subagents/);
});

test('delegating again resumes the same subagent session', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE once', cwd: makeRepo(), agent: 'claude', worktree: false, subagents: [{ agent: 'codex' }] });
  await settled(s.id);
  await api(`/sessions/${s.id}/reply`, { text: 'DELEGATE twice' });
  const done = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 2 && x.state === 'review' && x;
  });
  const child = Object.values(done.childSessions)[0];
  assert.equal(Object.keys(done.childSessions).length, 1);
  assert.equal(child.turns.length, 2);
  assert.ok(records(RECORD, 'codex').at(-1).argv.includes('codex-session-1'), 'resumed by id');
});

test('presets: save a team, launch from it, edit and delete it; deleting a lead removes its subagents', async () => {
  const p = await api('/teams', { name: 'Review crew', members: TEAM });
  assert.deepEqual(p.members.map((m) => [m.name, m.use]), [['codex', 'image stuff'], ['researcher', 'research']]);
  assert.equal((await api('/config')).teams.length, 1);
  await assert.rejects(api('/teams', { name: 'Empty', members: [] }), /at least one/);
  await assert.rejects(api('/teams', { name: 'Bad', members: [{ agent: 'nope' }] }), /unknown subagent harness/);

  const s = await api('/sessions', { prompt: 'DELEGATE from a preset', cwd: makeRepo(), agent: 'claude', worktree: false, preset: p.id });
  const done = await settled(s.id);
  assert.deepEqual(done.subagents.map((m) => m.name), ['codex', 'researcher']);

  const edited = await api(`/teams/${p.id}`, { members: [{ agent: 'opencode', use: 'docs' }] }, 'PATCH');
  assert.deepEqual(edited.members.map((m) => m.name), ['opencode']);
  assert.equal(edited.name, 'Review crew');

  const kids = Object.values(done.children);
  await api(`/sessions/${s.id}`, undefined, 'DELETE');
  for (const k of kids) await assert.rejects(api(`/sessions/${k}`), /no such session/);
  await api(`/teams/${p.id}`, undefined, 'DELETE');
  assert.equal((await api('/teams')).length, 0);
});

test('a lead without a team gets no delegate tool and no team note', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE nothing', cwd: makeRepo(), agent: 'claude', worktree: false });
  const done = await settled(s.id);
  assert.match(done.turns[0].presentation.blocks[0].summary, /no delegate tool/);
  assert.equal(done.team, undefined);
  const run = records(RECORD, 'claude').find((r) => r.stdin.includes('DELEGATE nothing'));
  assert.ok(!run.argv.includes('--disallowedTools'), 'built-in subagents stay on without a team');
});

test('a follow-up gives a task launched without subagents a team, and another follow-up takes it away', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE not yet', cwd: makeRepo(), agent: 'claude', worktree: false });
  await settled(s.id);
  await assert.rejects(api(`/sessions/${s.id}/reply`, { text: 'x', subagents: [{ agent: 'nope' }] }), /unknown subagent harness/);
  await assert.rejects(api(`/sessions/${s.id}/reply`, { text: 'x', preset: 'missing' }), /no such subagent preset/);

  await api(`/sessions/${s.id}/reply`, { text: 'DELEGATE now', subagents: [{ agent: 'codex', use: 'tests' }] });
  const done = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 2 && x.state === 'review' && x;
  });
  assert.deepEqual(done.subagents.map((m) => m.name), ['codex']);
  assert.equal(done.turns[1].delegations?.[0]?.name, 'codex');
  const run = records(RECORD, 'claude').find((r) => r.stdin.includes('DELEGATE now'));
  assert.ok(run.argv.includes('--disallowedTools'), 'built-in subagents switch off once there is a team');
  assert.match(run.argv.join(' '), /`codex`: Codex · default model\. Use it for: tests/);

  await api(`/sessions/${s.id}/reply`, { text: 'DELEGATE without', subagents: [] });
  const after = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 3 && x.state === 'review' && x;
  });
  assert.equal(after.subagents, undefined);
  assert.match(after.turns[2].presentation.blocks[0].summary, /no delegate tool/);
  assert.equal(Object.keys(after.children).length, 1, 'the child session it used stays linked');
});

test('a follow-up that interrupts the lead leaves its delegates working, and their reports come back to it', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE SLOW the review', cwd: makeRepo(), agent: 'claude', worktree: false, subagents: [{ agent: 'codex' }] });
  await until(async () => (await api(`/sessions/${s.id}`)).turns[0].delegations?.length);
  await api(`/sessions/${s.id}/reply`, { text: 'Meanwhile, rename the helper', queue: false });

  // The lead's next turn starts at once, waits on the delegate it was interrupted with, and is told about it.
  const second = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length >= 2 && x;
  });
  assert.equal(second.turns[0].status, 'stopped');
  assert.equal(second.turns[0].delegations, undefined, 'moved to the new turn');
  assert.equal(second.turns[1].delegations?.[0]?.name, 'codex');
  const child = Object.values(second.childSessions)[0];
  assert.equal(child.turns[0].status, 'running', 'the delegate kept working');
  const told = await until(() => records(RECORD, 'claude').find((r) => r.stdin.includes('Meanwhile, rename the helper')));
  assert.match(told.stdin, /still on it, or done and not yet read: codex \(id \w+\)/);

  // That turn ends before the delegate does, so its report arrives as a follow-up from wisp.
  const done = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 3 && x.state === 'review' && x;
  });
  const back = done.turns[2];
  assert.equal(back.by, 'wisp');
  assert.equal(back.reports, true);
  assert.match(back.prompt, /^Subagents you delegated to earlier have finished/);
  assert.match(back.prompt, /### codex \(Codex · default model\) — done/);
  assert.equal(Object.values(done.childSessions)[0].turns[0].status, 'done');
  assert.ok(!done.turns.flatMap((t) => t.delegations || []).some((d) => d.owed), 'nothing left owed');
});

test('stopping a lead stops its delegates and sends nothing back', async () => {
  const s = await api('/sessions', { prompt: 'DELEGATE SLOW then stop', cwd: makeRepo(), agent: 'claude', worktree: false, subagents: [{ agent: 'codex' }] });
  await until(async () => (await api(`/sessions/${s.id}`)).turns[0].delegations?.length);
  await api(`/sessions/${s.id}/stop`, {});
  const done = await settled(s.id);
  await new Promise((r) => setTimeout(r, 3500)); // past the delegate's 3s of work
  const after = await api(`/sessions/${s.id}`);
  assert.equal(after.turns.length, 1);
  assert.equal(Object.values(done.childSessions)[0].turns[0].status, 'stopped');
  assert.ok(!after.turns[0].delegations.some((d) => d.owed));
});

test('a lead with a delegate on another machine hears what travels; its paths are made relative', async () => {
  const { teamNote } = await import('../server/subagents.js');
  const { inFolder } = await import('../server/services/relay.js');
  const adapters = { codex: { name: 'Codex' } };
  const away = teamNote([{ name: 'boxer', agent: 'codex', count: 1, machine: 'm1', place: 'devbox' }], adapters, 'delegate');
  assert.match(away, /on devbox/);
  assert.match(away, /Don't commit or push/);
  assert.match(away, /never by absolute paths/);
  assert.doesNotMatch(teamNote([{ name: 'mate', agent: 'codex', count: 1 }], adapters, 'delegate'), /commit or push/);
  assert.equal(inFolder('Fix /work/repo/src/a.ts, run tests in /work/repo.', '/work/repo/'), 'Fix src/a.ts, run tests in ..');
  assert.equal(inFolder('Not /work/repo2/x nor /work/repo.git', '/work/repo'), 'Not /work/repo2/x nor /work/repo.git');
  assert.equal(inFolder('C:\\w\\repo\\src\\b.js', 'C:\\w\\repo'), 'src\\b.js');
});
