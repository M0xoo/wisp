// The crew: long-lived agents with a name, a schedule and a memory, whose work runs as tasks.
// The pure parts (members, mentions, memory, the schedule), then a real wisp server with fake
// harnesses: check-ins (quiet ones filed), jobs in parallel with a queue, @Name in a launch and in
// a follow-up, delegation from a lead, triggers, and a task joining the crew.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { applyMemory, crewJobOf, crewMentions, crewNote, dueNow, localKit, nextCheckin, normalizeKit, offerFiles, normalizeMember, NOTEBOOK_MAX, takeCrewBlock } from '../server/crew.js';
import { parseSkillMd } from '../web/js/skill-md.js';

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

test('a kit: instructions files and skills, checked; the note has the instructions and lists the skills', () => {
  assert.throws(() => normalizeKit('x'), /a list of files/);
  assert.throws(() => normalizeKit([{ kind: 'macro', name: 'a', body: 'b' }]), /skill or an instructions file/);
  assert.throws(() => normalizeKit([{ kind: 'skill', name: 'Release Notes', description: 'x', body: 'b' }]), /lowercase letters, digits and dashes/);
  assert.throws(() => normalizeKit([{ kind: 'skill', name: 'notes', body: 'b' }]), /Say when notes should be used/);
  assert.throws(() => normalizeKit([{ kind: 'rules', name: 'AGENTS.md', body: '  ' }]), /AGENTS\.md is empty/);
  assert.throws(() => normalizeKit([{ kind: 'rules', name: 'a.md', body: 'x'.repeat(50_001) }]), /too long/);
  assert.throws(() => normalizeKit([{ kind: 'rules', name: 'a.md', body: 'x' }, { kind: 'rules', name: 'A.md', body: 'y' }]), /two instructions files named A\.md/);
  assert.throws(() => normalizeKit(Array.from({ length: 25 }, (_, i) => ({ kind: 'rules', name: `r${i}`, body: 'x' }))), /At most 24/);
  const kit = normalizeKit([
    { kind: 'rules', name: 'AGENTS.md', body: 'Never push to main.\r\n' },
    { kind: 'skill', name: 'release-notes', description: 'Writing  release notes.', body: '1. Read the tags.', path: '/nope', on: true },
    { kind: 'skill', name: 'old', description: 'Unused.', body: 'x', on: false },
  ], () => false);
  assert.deepEqual(kit.map((k) => [k.kind, k.name, k.on]), [['rules', 'AGENTS.md', true], ['skill', 'release-notes', true], ['skill', 'old', false]]);
  assert.equal(kit[1].description, 'Writing release notes.');
  assert.equal(kit[1].path, undefined, 'a folder that isn’t there is dropped');
  assert.ok(kit.every((k) => /^[a-z0-9]{6,40}$/.test(k.id)));
  // Editing the member keeps its kit; kit: [] clears it.
  const m = normalizeMember({ name: 'Ada', kit });
  assert.equal(normalizeMember({ role: 'x' }, m, { taken: [m] }).kit.length, 3);
  assert.equal(normalizeMember({ kit: [] }, m, { taken: [m] }).kit.length, 0);
  // Here: the instructions in full, the skills by name with their file; off ones not at all.
  const here = crewNote(m, { job: 'task' }, { 'release-notes': '/w/crew/x/skills/release-notes/SKILL.md' });
  assert.match(here, /### Your instructions \(from the user\)[\s\S]*#### AGENTS\.md\n\nNever push to main\./);
  assert.match(here, /- \*\*release-notes\*\*: Writing release notes\. `\/w\/crew\/x\/skills\/release-notes\/SKILL\.md`/);
  assert.doesNotMatch(here, /1\. Read the tags|Unused/);
  // On another machine (no files): the skills written out.
  assert.match(crewNote(m, { job: 'task' }), /#### Skill: release-notes\n\nWhen: Writing release notes\.\n\n1\. Read the tags\./);
  assert.doesNotMatch(crewNote(normalizeMember({ name: 'Bo' }), {}), /Your instructions|Your skills/);
});

test('kit offers: a job proposes files, each checked on its own; a kit job is told how', () => {
  const data = takeCrewBlock({ blocks: [{ type: 'hero', title: 'x' }, { type: 'crew', kit: [{ kind: 'skill', name: 'Release Notes', description: 'Releases.', body: 'Steps' }, 'junk', { kind: 'skill', name: 'x', body: 'no description' }, { kind: 'instructions', name: 'AGENTS.md', body: 'Rules' }] }] });
  assert.deepEqual(offerFiles(data.kit), [{ kind: 'skill', name: 'release-notes', description: 'Releases.', body: 'Steps' }, { kind: 'rules', name: 'AGENTS.md', body: 'Rules' }]);
  const m = normalizeMember({ name: 'Ada', role: 'UI engineer' });
  assert.deepEqual(m.offers, []);
  assert.match(crewNote(m, { job: 'task', kit: true }), /build your own kit[\s\S]*2 to 6 files/);
  assert.doesNotMatch(crewNote(m, { job: 'task' }), /build your own kit/);
  assert.match(crewNote(m, { job: 'task' }), /- kit: skills or instructions files you propose/);
});

test('SKILL.md front matter, and the skills and instructions already on a computer', () => {
  assert.deepEqual(parseSkillMd('---\r\nname: pdf\r\ndescription: >\r\n  Fill PDF forms\r\n  and merge them.\r\n---\r\n\r\n# PDF\r\nSteps'), { name: 'pdf', description: 'Fill PDF forms and merge them.', body: '# PDF\nSteps' });
  assert.deepEqual(parseSkillMd('---\nname: "x"\ndescription: \'Quoted: yes\'\n---\nB'), { name: 'x', description: 'Quoted: yes', body: 'B' });
  assert.deepEqual(parseSkillMd('# Just text'), { name: '', description: '', body: '# Just text' });
  const home = tmp('kit-home');
  const proj = tmp('kit-proj');
  fs.mkdirSync(path.join(home, '.claude/skills/pdf/scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/pdf/SKILL.md'), '---\nname: pdf\ndescription: PDFs.\n---\nUse scripts/fill.py');
  fs.mkdirSync(path.join(home, '.agents/skills/Notes'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents/skills/Notes/SKILL.md'), 'No front matter');
  fs.mkdirSync(path.join(home, '.agents/skills/empty'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex/AGENTS.md'), 'Be brief.');
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'Run npm test.');
  const { skills, rules } = localKit({ home, cwd: proj });
  assert.deepEqual(skills.map((x) => [x.name, x.description, x.from, x.files || 0]), [['pdf', 'PDFs.', '~/.claude/skills/pdf', 1], ['notes', '', '~/.agents/skills/Notes', 0]]);
  assert.equal(skills[0].path, path.join(home, '.claude/skills/pdf'), 'a skill with files beside it keeps its folder');
  assert.deepEqual(rules.map((x) => [x.name, x.from, x.body]), [['AGENTS.md', '~/.codex/AGENTS.md', 'Be brief.'], ['AGENTS.md', `${path.basename(proj)}/AGENTS.md`, 'Run npm test.']]);
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

test('@Name first and another further in: the second joins the first one’s job as a delegate', async () => {
  const di = await api('/crew', { name: 'Di', role: 'Designer', agent: 'claude', cwd: repo });
  const job = await api('/sessions', { prompt: '@Ada and @[Di](crew:' + di.id + ') redo the crew section', cwd: repo });
  assert.deepEqual(jobOf(job), { id: ada.id, job: 'task' });
  assert.deepEqual(job.team.map((x) => x.crew), [di.id], 'Di is on Ada’s team for it, not dropped');
  await ended(job.id);
  const told = records(RECORD, 'claude').find((x) => x.stdin.includes('redo the crew section'));
  assert.match(told.argv.join(' '), /`di`: Di, Designer, a member of the user's crew.*hand them their part/);
  // The same in a follow-up: Ada answers on the task, with Di to hand work to.
  const task = await api('/sessions', { prompt: 'Fix the add function', cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(task.id);
  const r = await api(`/sessions/${task.id}/reply`, { text: '@Ada look at this with @Di' });
  const answer = await api(`/sessions/${r.crew[0].job}`);
  assert.deepEqual(answer.subagents.map((x) => x.crew), [di.id]);
  await ended(answer.id);
  await api(`/crew/${di.id}`, undefined, 'DELETE');
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

test('a member’s skills are written out as SKILL.md files its jobs read, and listed in their prompt', async () => {
  const cwd = makeRepo();
  const kit = [
    { kind: 'rules', name: 'AGENTS.md', body: 'KITRULE always run the tests' },
    { kind: 'skill', name: 'release-notes', description: 'Writing release notes.', body: 'KITSKILL read the tags' },
  ];
  const di = await api('/crew', { name: 'Di', agent: 'claude', cwd, kit });
  assert.deepEqual(di.kit.map((k) => [k.kind, k.name, k.on]), [['rules', 'AGENTS.md', true], ['skill', 'release-notes', true]]);
  await assert.rejects(api(`/crew/${di.id}`, { kit: [{ kind: 'skill', name: 'x', body: 'y' }] }, 'PATCH'), /Say when x should be used/);
  const { session } = await api(`/crew/${di.id}/jobs`, { prompt: 'KITJOB write the notes' });
  await ended(session.id);
  const run = records(RECORD, 'claude').find((r) => r.stdin.includes('KITJOB'));
  const file = path.join(process.env.WISP_HOME, 'crew', di.id, 'skills', 'release-notes', 'SKILL.md');
  const args = run.argv.join(' ');
  assert.match(args, /KITRULE always run the tests/);
  assert.ok(args.includes(`**release-notes**: Writing release notes. \`${file}\``));
  assert.doesNotMatch(args, /KITSKILL/, 'a skill’s steps stay in its file');
  assert.ok(run.argv.includes(path.dirname(file)), 'its folder is readable (--add-dir)');
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nname: release-notes\ndescription: "Writing release notes\."\n---\n\nKITSKILL read the tags/);
  // Turned off, its file goes on the next job; leaving the crew removes the rest.
  await api(`/crew/${di.id}`, { kit: di.kit.map((k) => ({ ...k, on: k.kind !== 'skill' })) }, 'PATCH');
  await ended((await api(`/crew/${di.id}/jobs`, { prompt: 'KITJOB2' })).session.id);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotMatch(records(RECORD, 'claude').find((r) => r.stdin.includes('KITJOB2')).argv.join(' '), /release-notes/);
  await api(`/crew/${di.id}`, null, 'DELETE');
  assert.equal(fs.existsSync(path.join(process.env.WISP_HOME, 'crew', di.id)), false);
  // Build your kit: the job proposes files, kept on the member as an offer until you pick.
  const ed = await api('/crew', { name: 'Ed', role: 'UI engineer', agent: 'claude', cwd });
  const out = await api(`/crew/${ed.id}/jobs`, { prompt: 'CREWKIT be the best UI engineer', kit: true });
  assert.equal(out.session.crew.kit, true);
  await ended(out.session.id);
  assert.match(records(RECORD, 'claude').find((r) => r.stdin.includes('CREWKIT')).argv.join(' '), /build your own kit/);
  const offered = await until(async () => (await api(`/crew/${ed.id}`)).offers?.[0]);
  assert.deepEqual([offered.job, offered.state, offered.files.map((f) => f.name)], [out.session.id, 'open', ['ui-review', 'AGENTS.md']]);
  assert.equal((await api(`/crew/${ed.id}`)).kit.length, 0, 'nothing joins the kit by itself');
  // Adding them: the kit with the files, and the offer settled, in one PATCH.
  const after = await api(`/crew/${ed.id}`, { kit: offered.files, offers: [{ id: offered.id, state: 'taken', names: ['ui-review', 'AGENTS.md'] }] }, 'PATCH');
  assert.deepEqual(after.kit.map((k) => k.name), ['ui-review', 'AGENTS.md']);
  assert.deepEqual([after.offers[0].state, after.offers[0].names], ['taken', ['ui-review', 'AGENTS.md']]);
  // A bad kit settles nothing.
  await assert.rejects(api(`/crew/${ed.id}`, { kit: [{ kind: 'skill', name: 'x', body: 'y' }], offers: [{ id: offered.id, state: 'dismissed' }] }, 'PATCH'), /Say when/);
  assert.equal((await api(`/crew/${ed.id}`)).offers[0].state, 'taken');
  // A kit job with no goal gets one from the role.
  const plain = await api(`/crew/${ed.id}/jobs`, { kit: true });
  assert.ok(plain.session || plain.queued);
  await api(`/crew/${ed.id}`, null, 'DELETE');
  // What's on this computer, to add.
  const local = await api('/crew-kit');
  assert.ok(Array.isArray(local.skills) && Array.isArray(local.rules));
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

test('an agent adds, changes and removes crew members when the user asks; a member’s job can’t', async () => {
  const cwd = makeRepo();
  const said = async (prompt) => {
    const s = await api('/sessions', { prompt, cwd, agent: 'claude', mode: 'edits', worktree: false });
    return (await ended(s.id)).turns.at(-1).presentation.blocks[0].summary;
  };
  assert.match(await said('CREWHIRE: add a docs writer to my crew'), /Added Quill to the user's crew\. \| \d+ on the user's crew:/);
  let quill = (await api('/crew')).find((m) => m.name === 'Quill');
  assert.deepEqual([quill.role, quill.brief, quill.cron, quill.agent, quill.cwd], ['Docs writer', 'Keep the README current.', '0 9 * * 1-5', 'claude', cwd], 'no folder given: the task’s project');
  // A second Quill is refused, and the agent hears why.
  assert.match(await said('CREWHIRE again'), /wisp: Quill is already on your crew/);

  assert.match(await said('CREWEDIT: make Quill the docs lead and pause them'), /Updated Quill\..*Docs lead.*paused/);
  quill = await api(`/crew/${quill.id}`);
  assert.deepEqual([quill.role, quill.paused, quill.brief], ['Docs lead', true, 'Keep the README current.'], 'only the fields given change');

  // A member's own job can't change the crew.
  const bo = await api('/crew', { name: 'Bo', cwd, agent: 'claude', mode: 'edits' });
  const { session } = await api(`/crew/${bo.id}/jobs`, { prompt: 'CREWFIRE Quill' });
  assert.match((await ended(session.id)).turns.at(-1).presentation.blocks[0].summary, /Only a task the user started can change their crew/);
  assert.ok((await api('/crew')).some((m) => m.name === 'Quill'));

  assert.match(await said('CREWFIRE: remove Quill from my crew'), /Removed Quill from the user's crew/);
  assert.ok(!(await api('/crew')).some((m) => m.name === 'Quill'));
  await api(`/crew/${bo.id}`, undefined, 'DELETE');
});
