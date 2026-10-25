// The crew: long-lived agents with a name, a schedule and a memory, whose work runs as tasks.
// The pure parts (members, mentions, memory, the schedule), then a real wisp server with fake
// harnesses: check-ins (quiet ones filed), jobs in parallel with a queue, @Name in a launch and in
// a follow-up, delegation from a lead, triggers, and a task joining the crew.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';
import { applyMemory, crewJobOf, crewMentions, crewNote, dueNow, nextCheckin, normalizeMember, NOTEBOOK_MAX, takeCrewBlock } from '../server/crew.js';

const RECORD = tmp('crew-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('crew-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

// --- pure ------------------------------------------------------------------------------------------

// A crew job's summary: who and what kind, without its prompt.
const jobOf = (x) => (({ id, job, from }) => ({ id, job, ...(from && { from }) }))(x.crew);
test('a member needs a unique, plain name, a known harness and a valid schedule', () => {
  assert.throws(() => normalizeMember({}), /Give them a name/);
  assert.throws(() => normalizeMember({ name: '<b>x' }), /up to 24 letters/);
  assert.throws(() => normalizeMember({ name: 'ada' }, null, { taken: [{ id: 'x', name: 'Ada' }] }), /already on your crew/);
  assert.throws(() => normalizeMember({ name: 'Ada', agent: 'nope' }), /Unknown harness/);
  assert.throws(() => normalizeMember({ name: 'Ada', cron: 'every day' }), /5 fields/);
  assert.throws(() => normalizeMember({ name: 'Ada', cwd: '/nope' }, null, { exists: () => false }), /Not a folder/);
  const m = normalizeMember({ name: '  Ada  ', role: 'CI watcher', avatar: '🦊', cron: '@hourly', parallel: 9, brief: 'Watch CI' });
  assert.equal(m.name, 'Ada');
  assert.equal(m.agent, 'auto');
  assert.equal(m.parallel, 5);
  assert.deepEqual([m.notebook, m.log, m.queue], ['', [], []]);
  // Editing keeps the memory.
  m.notebook = 'facts';
  m.log.push({ title: 'x' });
  const edited = normalizeMember({ role: 'Release manager' }, m, { taken: [m] });
  assert.equal(edited.id, m.id);
  assert.equal(edited.notebook, 'facts');
  assert.equal(edited.log.length, 1);
});

test('a member on a machine: a machine you have, its folder there unchecked here; a job sent from another wisp', () => {
  assert.throws(() => normalizeMember({ name: 'Ada', machine: 'nope99' }), /isn’t one of yours/);
  const m = normalizeMember({ name: 'Ada', machine: 'abc123', cwd: '/home/me/repo' }, null, { exists: () => false, machineOk: (id) => id === 'abc123' });
  assert.deepEqual([m.machine, m.cwd, m.away, m.seen], ['abc123', '/home/me/repo', {}, []]);
  // Moving it to another place drops what it was waiting on there; its memory stays.
  m.away = { 'x@abc123': {} };
  m.notebook = 'kept';
  const moved = normalizeMember({ machine: '' }, m, { taken: [m], exists: () => true, machineOk: () => true });
  assert.deepEqual([moved.machine, moved.away, moved.notebook], ['', {}, 'kept']);
  assert.equal(crewJobOf({ id: 'abc123def', note: 'x' }).job, 'task');
  assert.deepEqual(crewJobOf({ id: 'abc123def', job: 'mention', from: { id: 'a', title: 'T' }, note: 'n', evil: 1 }), { id: 'abc123def', job: 'mention', from: { id: 'a', title: 'T' }, note: 'n' });
  assert.equal(crewJobOf({ id: 'Bad id', note: 'x' }), null);
  assert.equal(crewJobOf({ id: 'abc123def' }), null, 'no note, no crew job');
});

test('@mentions: stored tokens and plain names, addressed (leading) or in passing', () => {
  const ada = { id: 'aaaaaaaa1', name: 'Ada' };
  const bo = { id: 'bbbbbbbb1', name: 'Bo Lee' };
  const crew = [ada, bo];
  let t = crewMentions('@[Ada](crew:aaaaaaaa1) check the deploy', crew);
  assert.deepEqual(t.lead, [ada]);
  assert.equal(t.rest, 'check the deploy');
  t = crewMentions('@ada, @Bo Lee: look at #12', crew);
  assert.deepEqual(t.lead, [ada, bo]);
  assert.equal(t.rest, 'look at #12');
  t = crewMentions('fix it, then have @bo-lee review it', crew);
  assert.deepEqual(t.lead, []);
  assert.deepEqual(t.all, [bo]);
  assert.equal(t.rest, 'fix it, then have @bo-lee review it');
  // Not a mention: inside a word, an email, or a longer name.
  assert.deepEqual(crewMentions('mail ada@x.com and @Adam', crew).all, []);
});

test('a job hands memory back in a hidden crew block: lines added, a rewrite, a wake-up', () => {
  const p = { blocks: [{ type: 'hero', title: 'CI green' }, { type: 'crew', remember: ['last run 41', ''], wakeIn: 2, quiet: true }] };
  const data = takeCrewBlock(p);
  assert.deepEqual(p.blocks.map((b) => b.type), ['hero']);
  assert.deepEqual(data, { remember: ['last run 41'], wakeIn: 2, quiet: true });
  const m = { notebook: 'old fact', wakeAt: null };
  applyMemory(m, data, 1_000);
  assert.equal(m.notebook, 'old fact\n- last run 41');
  assert.equal(m.wakeAt, 1_000 + 5 * 60_000, 'a wake-up is at least 5 minutes away');
  applyMemory(m, { notebook: 'tidy', remember: [] });
  assert.equal(m.notebook, 'tidy');
  // Past the cap, the oldest lines go.
  applyMemory(m, { notebook: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n') });
  assert.ok(m.notebook.length <= NOTEBOOK_MAX && m.notebook.endsWith('line 2999'));
  // Only a crew block: the report still has a hero.
  const only = { blocks: [{ type: 'crew', quiet: true }] };
  takeCrewBlock(only);
  assert.equal(only.blocks[0].type, 'hero');
});

test('the schedule: cron minutes once each, wake-ups, paused members never', () => {
  const at = new Date(2026, 9, 25, 9, 0, 10).getTime();
  const m = { cron: '0 9 * * *', paused: false, wakeAt: null, lastMinute: null };
  assert.equal(dueNow(m, at), true);
  m.lastMinute = Math.floor(at / 60_000);
  assert.equal(dueNow(m, at), false, 'once per minute');
  assert.equal(dueNow({ ...m, cron: '', wakeAt: at - 1 }, at), true);
  assert.equal(dueNow({ ...m, paused: true, wakeAt: at - 1 }, at), false);
  assert.equal(nextCheckin({ ...m, wakeAt: at + 60_000 }, at), at + 60_000, 'a wake-up before the schedule comes first');
  assert.equal(nextCheckin({ ...m, paused: true }, at), null);
});

test('the crew note carries the brief, the notebook, the log and where the job came from', () => {
  const m = { name: 'Ada', role: 'CI watcher', brief: 'Watch CI on main', notebook: 'build 41 was green', cron: '@hourly', log: [{ at: Date.now(), job: 'checkin', title: 'CI green', summary: 'nothing new', quiet: true }] };
  const note = crewNote(m, { job: 'delegated', from: { id: 'abc123abc123', title: 'Fix login' } });
  assert.match(note, /## You are Ada, on the user's crew/);
  assert.match(note, /Your role: CI watcher/);
  assert.match(note, /Watch CI on main/);
  assert.match(note, /<notebook>\nbuild 41 was green\n<\/notebook>/);
  assert.match(note, /check-in · CI green: nothing new \(nothing new\)/);
  assert.match(note, /Delegated to you by the agent working on "Fix login" \(wisp task abc123abc123\)/);
  assert.match(note, /quiet: only for check-ins/);
  assert.match(crewNote(m, { job: 'checkin' }), /quiet: true when this check-in found nothing/);
});

// --- through the server ------------------------------------------------------------------------------

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
const ended = (id) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && x;
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

let ada;
let repo;

test('a check-in that found nothing is filed quietly, and what it learned is remembered', async () => {
  repo = makeRepo();
  ada = await api('/crew', { name: 'Ada', role: 'CI watcher', avatar: '🦊', brief: 'Watch CI. CREWQUIET', cwd: repo, agent: 'claude', mode: 'edits', parallel: 1 });
  assert.equal(ada.handle, 'ada');
  const { session } = await api(`/crew/${ada.id}/checkin`, {});
  assert.deepEqual(jobOf(session), { id: ada.id, job: 'checkin' });
  const done = await ended(session.id);
  assert.equal(done.state, 'done');
  assert.equal(done.archived, true);
  assert.equal(done.unread, false);
  assert.ok(!done.turns[0].presentation.blocks.some((b) => b.type === 'crew'), 'the crew block is hidden');
  // The run heard who it is and its brief.
  const run = records(RECORD, 'claude').find((r) => r.stdin.startsWith('Check-in #1'));
  assert.match(run.argv.join(' '), /## You are Ada, on the user's crew[\s\S]*Watch CI\. CREWQUIET/);
  const m = await until(async () => {
    const x = await api(`/crew/${ada.id}`);
    return x.log.length && x;
  });
  assert.equal(m.notebook, '- saw build 41');
  assert.equal(m.checkins, 1);
  assert.equal(m.log[0].quiet, true);
  assert.equal(m.jobList[0].id, session.id);
});

test('@Name at the start of a prompt is a job for them; past their limit, work waits in the queue', async () => {
  const first = await api('/sessions', { prompt: '@Ada CREWNOTE check the deploy', cwd: repo });
  assert.deepEqual(jobOf(first), { id: ada.id, job: 'task' });
  const second = await api('/sessions', { prompt: '@[Ada](crew:' + ada.id + ') and the docs', cwd: repo });
  assert.equal(second.queued, 1, 'parallel 1: the second job waits');
  const a = await ended(first.id);
  assert.equal(a.state, 'review', 'a job for the user lands in Needs you');
  assert.equal(a.turns[0].prompt, 'CREWNOTE check the deploy');
  // The queued one starts once there's room.
  const m = await until(async () => {
    const x = await api(`/crew/${ada.id}`);
    return x.jobList.length === 3 && !x.queue.length && x;
  });
  assert.match(m.notebook, /- deploy is v2/);
  assert.ok(m.wakeAt > Date.now() + 25 * 60_000, 'it asked to look again in 30 minutes');
  assert.ok(m.nextAt <= m.wakeAt);
  await ended(m.jobList[0].id);
});

test('@Name starting a follow-up: they answer on the task, under the message', async () => {
  await api(`/crew/${ada.id}`, { parallel: 3 }, 'PATCH');
  const task = await api('/sessions', { prompt: 'Fix the add function', cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(task.id);
  const r = await api(`/sessions/${task.id}/reply`, { text: '@Ada what do you make of this?' });
  assert.equal(r.crew[0].crew.name, 'Ada');
  const t = await until(async () => {
    const x = await api(`/sessions/${task.id}`);
    const e = x.turns.at(-1).btw?.[0];
    return e?.status === 'done' && x;
  });
  const entry = t.turns.at(-1).btw[0];
  assert.equal(t.turns.length, 1, "the task's own agent wasn't sent anything");
  assert.match(entry.answer, /Fake claude finished/);
  const job = await api(`/sessions/${entry.job}`);
  assert.deepEqual([job.crew.id, job.crew.job, job.crew.from], [ada.id, 'mention', { id: task.id, title: t.title }]);
  assert.equal(job.crew.reply.entryId, entry.id);
  assert.equal(job.state, 'done', 'its answer went to the task: the job itself is filed, not in Needs you');
  assert.equal(job.unread, false);
});

test('@Name further in a prompt: the task’s agent can delegate to them, and the job is theirs', async () => {
  const lead = await api('/sessions', { prompt: 'DELEGATE this review, with @Ada', cwd: makeRepo(), agent: 'claude', worktree: false });
  assert.deepEqual(lead.team.map((m) => [m.name, m.crew]), [['ada', ada.id]]);
  const done = await ended(lead.id);
  const d = done.turns[0].delegations[0];
  assert.equal(d.crew, ada.id);
  const job = done.childSessions[d.sessionId];
  assert.deepEqual(jobOf(job), { id: ada.id, job: 'delegated', from: { id: lead.id, title: job.crew.from.title } });
  assert.equal(job.cwd, repo, 'it works in its own folder');
  assert.match(done.turns[0].presentation.blocks[0].summary, /### ada/);
  const told = records(RECORD, 'claude').find((x) => x.stdin.includes('DELEGATE this review'));
  assert.match(told.argv.join(' '), /`ada`: Ada, CI watcher, a member of the user's crew/);
});

test('a member follows up on the task that tagged it by itself, and you reply in its thread there', async () => {
  const task = await api('/sessions', { prompt: 'Ship the login fix', cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(task.id);
  const r = await api(`/sessions/${task.id}/reply`, { text: '@Ada CREWFOLLOW have a look' });
  const first = r.crew[0];
  // Its answer lands on the task, and its own follow-up reaches the task's agent, from Ada.
  const t = await until(async () => {
    const x = await api(`/sessions/${task.id}`);
    return x.turns.length === 2 && x.turns[1].status !== 'running' && x;
  });
  assert.match(t.turns[1].prompt, new RegExp(`^@\\[Ada\\]\\(crew:${ada.id}\\) \\(your crew’s CI watcher\\):\n\nPlease rerun the tests after my note\\.$`));
  assert.equal(t.turns[1].btw[0].status, 'done', 'its thread moved along with its follow-up');
  assert.equal(t.turns[0].btw, undefined);
  const m = await api(`/crew/${ada.id}`);
  assert.equal(m.links[0].id, task.id, 'the task is linked to Ada');
  const job = (await api('/sessions')).find((x) => x.id === t.turns[1].btw[0].job);
  assert.deepEqual(job.crew.sent, [{ id: task.id, title: t.title }]);
  // Ada joined the task's delegates with that follow-up, so its agent can hand the work back.
  assert.deepEqual((t.subagents || []).map((x) => [x.name, x.crew]), [['ada', ada.id]]);
  const told = records(RECORD, 'claude').find((x) => x.stdin.includes('Please rerun the tests after my note'));
  assert.match(told.argv.join(' '), /`ada`: Ada, CI watcher, a member of the user's crew.*hand your work back to them/s);
  // You reply in the thread: the same job carries on, its answer lands right under yours.
  const e = await api(`/sessions/${task.id}/crew-reply`, { entry: first.id, text: 'and the docs?' });
  assert.equal(e.thread, first.id);
  const after = await until(async () => {
    const x = await api(`/sessions/${task.id}`);
    const list = x.turns[1].btw;
    return list.find((b) => b.id === e.id)?.status === 'done' && list;
  });
  assert.deepEqual(after.map((b) => b.id).slice(0, 2), [first.id, e.id], 'right after the answer it continues');
  const again = await api(`/sessions/${job.id}`);
  assert.equal(again.turns.length, 2, 'the same job, a second turn');
  assert.equal(again.turns[1].prompt, 'and the docs?');
  assert.deepEqual([again.state, again.unread], ['done', false], 'its answer went to the thread: filed again, nobody pinged');
  await assert.rejects(api(`/sessions/${task.id}/crew-reply`, { entry: 'nope', text: 'x' }), /no longer on your crew/);
  // The task's agent hands it back: a delegated job for Ada, whose follow-up to that same task is
  // dropped (the agent reads its report already), so the two can't bounce work back and forth.
  await api(`/sessions/${task.id}/reply`, { text: 'DELEGATE the check, CREWFOLLOW' });
  const back = await until(async () => {
    const x = await api(`/sessions/${task.id}`);
    return x.turns.length === 3 && x.state !== 'running' && x;
  });
  const d = back.turns[2].delegations[0];
  assert.equal(d.crew, ada.id);
  const kid = await api(`/sessions/${d.sessionId}`);
  assert.equal(kid.crew.job, 'delegated');
  assert.equal(kid.crew.sent, undefined, 'no follow-up to the lead that delegated it');
  assert.equal((await api(`/sessions/${task.id}`)).turns.length, 3);
});

test('a member has delegates of its own, other crew members too, but never itself and no loops', async () => {
  const bo = await api('/crew', { name: 'Bo', role: 'Tester', agent: 'claude', cwd: repo, team: [{ crew: ada.id, name: 'ada', label: 'Ada' }, { agent: 'codex', use: 'tests' }] });
  assert.deepEqual(bo.team.map((x) => x.crew || x.agent), [ada.id, 'codex']);
  const self = await api(`/crew/${ada.id}`, { team: [{ crew: ada.id, name: 'ada' }, { agent: 'codex' }] }, 'PATCH');
  assert.deepEqual(self.team.map((x) => x.crew || x.agent), ['codex'], 'not itself');
  const { session } = await api(`/crew/${bo.id}/jobs`, { prompt: 'Look around' });
  assert.deepEqual(session.team.map((x) => x.crew || x.agent), [ada.id, 'codex'], 'its job gets its team');
  await ended(session.id);
  // @Name in a job you send: they join that job's delegates (not the member's team).
  const cy = await api('/crew', { name: 'Cy', agent: 'claude', cwd: repo });
  const tagged = await api(`/crew/${bo.id}/jobs`, { prompt: 'Look again with @Cy' });
  assert.deepEqual(tagged.session.team.map((x) => x.crew || x.agent), [ada.id, 'codex', cy.id]);
  assert.deepEqual((await api(`/crew/${bo.id}`)).team.length, 2);
  await ended(tagged.session.id);
  await api(`/crew/${cy.id}`, null, 'DELETE');
  // A job delegated to Ada hands nothing on to the crew: Ada's codex only.
  await api(`/crew/${ada.id}`, { team: [{ crew: bo.id, name: 'bo' }, { agent: 'codex' }] }, 'PATCH');
  const lead = await api('/sessions', { prompt: 'DELEGATE this, with @Ada', cwd: makeRepo(), agent: 'claude', worktree: false });
  const done = await ended(lead.id);
  const kid = done.childSessions[done.turns[0].delegations[0].sessionId];
  assert.deepEqual((kid.subagents || []).map((x) => x.crew || x.agent), ['codex']);
  await api(`/crew/${ada.id}`, { team: [] }, 'PATCH');
  await api(`/crew/${bo.id}`, null, 'DELETE');
});

test('a trigger sends its work to a crew member', async () => {
  const t = await api('/triggers', { kind: 'schedule', cron: '0 0 1 1 *', crew: ada.id, prompt: 'Weekly dependency check' });
  assert.equal(t.cwd, repo, 'the member’s folder');
  const { started } = await api(`/triggers/${t.id}/run`, {});
  assert.deepEqual(jobOf(started[0]), { id: ada.id, job: 'trigger', from: { id: t.id, title: t.name } });
  assert.equal(started[0].origin.kind, 'trigger');
  await ended(started[0].id);
  // Leaving the crew turns the trigger off.
  const bo = await api('/crew', { name: 'Bo', agent: 'claude' });
  const t2 = await api('/triggers', { kind: 'schedule', cron: '0 0 1 1 *', crew: bo.id, prompt: 'x' });
  await api(`/crew/${bo.id}`, null, 'DELETE');
  const after = (await api('/triggers')).find((x) => x.id === t2.id);
  assert.equal(after.enabled, false);
  await assert.rejects(api('/triggers', { kind: 'schedule', cron: '0 0 1 1 *', crew: bo.id, prompt: 'x' }), /no longer on your crew/);
});

test('a task joins the crew: its folder, harness and first prompt become the member’s', async () => {
  const cwd = makeRepo();
  const s = await api('/sessions', { prompt: 'Keep the changelog tidy', cwd, agent: 'claude', model: 'opus', worktree: false });
  await ended(s.id);
  const cy = await api(`/sessions/${s.id}/crew`, { name: 'Cy', role: 'Changelog keeper', cron: '0 9 * * 1-5' });
  assert.equal(cy.cwd, cwd);
  assert.equal(cy.agent, 'claude');
  assert.equal(cy.model, 'opus');
  assert.equal(cy.brief, 'Keep the changelog tidy');
  assert.ok(cy.nextAt > Date.now());
  const sum = (await api('/sessions')).find((x) => x.id === s.id);
  assert.deepEqual(jobOf(sum), { id: cy.id, job: 'task' });
  await assert.rejects(api(`/sessions/${s.id}/crew`, { name: 'Dee' }), /already Cy’s/);
  // The next wake-up counts toward /status, so a host wakes wisp for it.
  const st = await api('/status');
  assert.ok(st.nextWakeAt && st.nextWakeAt <= cy.nextAt);
});
