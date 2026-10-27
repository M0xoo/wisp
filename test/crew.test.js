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
import { normalizeTrigger, triggerView, Triggers } from '../server/triggers.js';
import { newId } from '../server/util.js';
import { applyMemory, crewJobOf, crewMentions, crewNote, dueNow, localKit, nextCheckin, normalizeKit, offerFiles, normalizeMember, NOTEBOOK_MAX, takeCrewBlock } from '../server/crew.js';
import { parseSkillMd } from '../web/js/skill-md.js';
import { crewStats } from '../server/usage.js';

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
  assert.throws(() => normalizeMember({ name: 'Ada', cron: 'every blue moon' }), /Couldn’t read “every blue moon” as a schedule/);
  assert.throws(() => normalizeMember({ name: 'Ada', cron: '0 25 * * *' }), /Bad hour field/);
  assert.equal(normalizeMember({ name: 'Ada', cron: '8am every weekday' }).cron, '0 8 * * 1-5', 'words are stored as cron');
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

test('task watchers: their project only, at most 3 times a task, never helpers or what a watcher started', async () => {
  const dir = makeRepo();
  const launched = [];
  const store = { config: { triggers: [], crew: [], recipes: [], projects: [{ id: 'p', path: dir }] }, saveConfig() {}, projectFor: (cwd) => (cwd.startsWith(dir) ? { path: dir } : null) };
  const triggers = new Triggers({ store, launch: async (body, origin) => (launched.push({ body, origin }), { id: `s${launched.length}` }) });
  const t = normalizeTrigger({ kind: 'finished', cwd: dir }, null, store.config);
  assert.equal(t.name, 'Task finished');
  assert.match(t.prompt, /"\{title\}" \(wisp task \{id\}\)/);
  store.config.triggers.push(t);
  const task = (x = {}) => ({ id: 'a1', title: 'Fix it', cwd: dir, turns: [{ presentation: { blocks: [{ type: 'hero', title: 'Fixed', summary: 'Add works now.' }] } }], ...x });
  await Promise.all(triggers.taskEvent('finished', task()));
  assert.equal(launched[0].body.cwd, dir);
  assert.match(launched[0].body.prompt, /"Fix it" \(wisp task a1\) just finished: Add works now\./);
  assert.deepEqual(launched[0].origin, { kind: 'trigger', id: t.id, name: t.name });
  for (let i = 0; i < 4; i++) await Promise.all(triggers.taskEvent('finished', task()));
  assert.equal(launched.length, 3, 'at most 3 times for one task');
  for (const x of [{ cwd: makeRepo() }, { parentId: 'p1' }, { delegated: true }, { origin: { kind: 'trigger', id: t.id } }, { crew: { id: 'm', job: 'event' } }]) await Promise.all(triggers.taskEvent('finished', task({ id: newId(), ...x })));
  assert.equal(launched.length, 3, 'another project, helpers and watchers’ own work start nothing');
  assert.equal(triggers.taskEvent('done', task({ id: 'b2' })).length, 0, 'a finished watcher ignores done');
  await assert.rejects(triggers.runNow(t), /nothing to run now/);
  assert.equal(triggerView(t).nextAt, null);
  // Without a project it watches them all; GitHub watchers still need one.
  assert.equal(normalizeTrigger({ kind: 'done' }, null, store.config).cwd, '');
  assert.throws(() => normalizeTrigger({ kind: 'ci' }, null, store.config), /Pick the project/);
});

test('CI watchers: a failure on a branch that has a task goes to it as a follow-up', async () => {
  const dir = makeRepo();
  const sessions = new Map();
  const store = { config: { triggers: [], crew: [{ id: 'm', name: 'Flo', cwd: dir }], recipes: [], projects: [{ id: 'p', path: dir }] }, saveConfig() {}, sessions, get: (id) => sessions.get(id), projectFor: (cwd) => (cwd?.startsWith(dir) ? { path: dir } : null) };
  const launched = [];
  const assigned = [];
  const sent = [];
  const triggers = new Triggers({
    store,
    launch: async (body) => (launched.push(body), { id: `s${launched.length}` }),
    assign: async (crew, work) => (assigned.push({ crew, work }), { id: `j${assigned.length}` }),
    followUp: async (s, text) => (sent.push({ id: s.id, text }), { id: s.id, title: s.title }),
  });
  const run = (id, branch) => ({ id, name: 'test', branch, url: `u${id}` });
  const t = normalizeTrigger({ kind: 'ci', cwd: dir }, null, store.config);
  // Your task that opened the PR works in that branch's worktree: the failure goes to it.
  sessions.set('pr', { id: 'pr', cwd: dir, state: 'review', createdAt: 1, worktree: { branch: 'wisp/fix' } });
  sessions.set('other', { id: 'other', cwd: makeRepo(), state: 'review', createdAt: 2, worktree: { branch: 'wisp/fix' } });
  const out = await triggers.fire(t, run(1, 'wisp/fix'));
  assert.deepEqual([out.id, out.followUp, sent[0].id, launched.length], ['pr', true, 'pr', 0], 'not the same branch name in another project');
  assert.match(sent[0].text, /run view 1 --log-failed/);
  // A branch without one starts a task, and the next failure there goes to that task.
  await triggers.fire(t, run(2, 'main'));
  assert.equal(launched.length, 1);
  sessions.set('s1', { id: 's1', cwd: dir, state: 'running' });
  await triggers.fire(t, run(3, 'main'));
  assert.deepEqual([launched.length, sent.at(-1).id, t.runs], [1, 's1', 3]);
  // Marked done or archived, that work is over; deleted, it's gone.
  sessions.get('s1').state = 'done';
  await triggers.fire(t, run(4, 'main'));
  sessions.set('s2', { id: 's2', cwd: dir, state: 'review', archived: true });
  await triggers.fire(t, run(5, 'main'));
  await triggers.fire(t, run(6, 'main')); // s3 never shows up: deleted
  assert.deepEqual([launched.length, t.tasks.main], [4, 's4']);
  // A member's CI watcher follows up on its job too.
  const mt = normalizeTrigger({ kind: 'ci', crew: 'm' }, null, store.config);
  await triggers.fire(mt, run(7, 'dev'));
  sessions.set('j1', { id: 'j1', cwd: dir, state: 'review', crew: { id: 'm' } });
  await triggers.fire(mt, run(8, 'dev'));
  assert.deepEqual([assigned.length, sent.at(-1).id], [1, 'j1']);
  assert.equal(triggerView(t).tasks, undefined, 'the links stay on the server');
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
  assert.deepEqual([job.state, job.unread], ['review', true], 'you asked for it: it stays in Needs you until you mark it done');
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
  assert.deepEqual([again.state, again.unread], ['review', true], 'your reply in the thread: back in Needs you');
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

test('an agent reads a member in full, adds to their notebook and proposes kit files the user picks from', async () => {
  const cwd = makeRepo();
  const said = async (prompt) => {
    const s = await api('/sessions', { prompt, cwd, agent: 'claude', mode: 'edits', worktree: false });
    const done = await ended(s.id);
    return { s: done, text: done.turns.at(-1).presentation.blocks[0].summary };
  };
  const quill = await api('/crew', { name: 'Quill', role: 'Docs writer', brief: 'Keep the README current.', notebook: 'Docs live in docs/.', cwd, agent: 'claude' });

  assert.match((await said('CREWMEMO: Quill should know where release notes go')).text, /Updated Quill\..*notebook now has \d+ characters/);
  assert.equal((await api(`/crew/${quill.id}`)).notebook, 'Docs live in docs/.\n- Release notes go in CHANGELOG.md', 'remember adds lines to the end');
  assert.match((await said('CREWREAD: what does Quill know?')).text, /## Brief\s+Keep the README current\.\s+## Notebook\s+Docs live in docs\/\. - Release notes go in CHANGELOG\.md .*## Kit\s+No skills/);

  // A proposal changes nothing: it waits on the member as an offer, under the turn that made it.
  const { s, text } = await said('CREWPROPOSE: give Quill a skill for release notes');
  assert.match(text, /Proposed for Quill’s kit; nothing is added until the user picks\..*skill \*\*release-notes\*\*.*instructions \*\*AGENTS\.md\*\*.*Left out: - nope: Say when nope should be used/);
  let m = await api(`/crew/${quill.id}`);
  assert.deepEqual(m.kit, []);
  const [offer] = m.offers;
  assert.deepEqual([offer.job, offer.turn, offer.state, offer.files.map((f) => f.name)], [s.id, s.turns.at(-1).id, 'open', ['release-notes', 'AGENTS.md']]);
  // The user adds one: the kit takes it and the offer is settled.
  m = await api(`/crew/${quill.id}`, { kit: [{ ...offer.files[0] }], offers: [{ id: offer.id, state: 'taken', names: ['release-notes'] }] }, 'PATCH');
  assert.deepEqual([m.kit.map((k) => k.name), m.offers[0].state, m.offers[0].names], [['release-notes'], 'taken', ['release-notes']]);

  // A member's own job may propose too (the user still picks); only a subagent can't.
  const { session } = await api(`/crew/${quill.id}/jobs`, { prompt: 'CREWPROPOSE for yourself' });
  assert.match((await ended(session.id)).turns.at(-1).presentation.blocks[0].summary, /Proposed for Quill’s kit/);
  assert.ok((await api(`/crew/${quill.id}`)).offers.some((o) => o.job === session.id && o.state === 'open'));
  await api(`/crew/${quill.id}`, undefined, 'DELETE');
});

test('a member starts when a task finishes or is marked done, in its project, about that task', async () => {
  const cwd = makeRepo();
  const vee = await api('/crew', { name: 'Vee', role: 'Verifier', brief: 'Check finished work.', cwd, agent: 'claude', parallel: 3, on: ['finished', 'done'] });
  assert.deepEqual(vee.on.sort(), ['done', 'finished']);
  const mine = (await api('/triggers')).filter((t) => t.crew === vee.id);
  assert.deepEqual(mine.map((t) => [t.kind, t.cwd]).sort(), [['done', ''], ['finished', '']], 'their project, worked out as tasks end');
  const jobs = async () => (await api('/sessions')).filter((x) => x.crew?.id === vee.id);

  // A task elsewhere: nothing. One in their project: a job about it, which it may follow up on.
  await ended((await api('/sessions', { prompt: 'Tidy the other repo', cwd: makeRepo(), agent: 'claude', worktree: false })).id);
  const task = await api('/sessions', { prompt: 'Fix the add function', cwd, agent: 'claude', worktree: false });
  await ended(task.id);
  const [job] = await until(async () => {
    const x = await jobs();
    return x.length && x;
  });
  assert.deepEqual(jobOf(job), { id: vee.id, job: 'event', from: { id: task.id, title: job.crew.from.title } });
  assert.equal(job.crew.event, 'finished');
  assert.equal(job.origin.kind, 'trigger');
  const full = await ended(job.id);
  assert.match(full.turns[0].prompt, new RegExp(`wisp task ${task.id}`));
  const run = records(RECORD, 'claude').find((r) => r.stdin.includes(`wisp task ${task.id}`));
  assert.match(run.argv.join(' '), /just finished, and you watch for that/);
  assert.ok((await api(`/crew/${vee.id}`)).links.some((l) => l.id === task.id), 'it may follow up on the task');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await jobs()).length, 1, 'its own job finishing starts nothing');

  // Marked done: a second job, about the same task.
  await api(`/sessions/${task.id}`, { state: 'done' }, 'PATCH');
  const done = await until(async () => (await jobs()).find((x) => x.crew.event === 'done'));
  assert.equal(done.crew.from.id, task.id);
  await ended(done.id);
  await api(`/sessions/${task.id}`, { state: 'done' }, 'PATCH');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await jobs()).filter((x) => x.crew.event === 'done').length, 1, 'only when it becomes done');

  // The editor's chips: a kind left out goes; CI needs a project here, and a refusal undoes the edit.
  const edited = await api(`/crew/${vee.id}`, { on: ['finished'] }, 'PATCH');
  assert.deepEqual(edited.on, ['finished']);
  assert.equal((await api('/triggers')).filter((t) => t.crew === vee.id).length, 1);
  const flo = await api('/crew', { name: 'Flo', agent: 'claude' });
  await assert.rejects(api(`/crew/${flo.id}`, { role: 'CI fixer', on: ['ci'] }, 'PATCH'), /Pick the project/);
  assert.equal((await api(`/crew/${flo.id}`)).role, '');
  await assert.rejects(api('/crew', { name: 'Gus', agent: 'claude', on: ['ci'] }), /Pick the project/);
  assert.ok(!(await api('/crew')).some((m) => m.name === 'Gus'), 'a refused new member doesn’t stay');
  await api(`/crew/${vee.id}`, { on: [] }, 'PATCH');
  assert.equal((await api('/triggers')).filter((t) => t.crew === vee.id).length, 0);
});

test('a check-in worth reading but not urgent is filed in For later: unread, nobody pinged, forLater beats quiet', async () => {
  const bo = await api('/crew', { name: 'Bo', role: 'Digest', brief: 'Send a digest. CREWLATER', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  const { session } = await api(`/crew/${bo.id}/checkin`, {});
  const done = await ended(session.id);
  assert.equal(done.state, 'review');
  assert.equal(done.archived, undefined, 'not archived like a quiet one');
  assert.equal(done.unread, true, 'still bold in For later');
  assert.equal(done.forLater.by, 'crew');
  const sum = (await api('/sessions')).find((x) => x.id === session.id);
  assert.equal(sum.forLater.by, 'crew');
  const m = await until(async () => {
    const x = await api(`/crew/${bo.id}`);
    return x.log.length && x;
  });
  assert.equal(m.log[0].forLater, true);
  assert.ok(!m.log[0].quiet);
  assert.match(crewNote(m, { job: 'checkin' }), /forLater: true when you found something worth reading/);
  assert.match(crewNote(m, { job: 'task' }), /forLater: only for check-ins/);
  // A follow-up on it is new work: it leaves For later.
  await api(`/sessions/${session.id}/reply`, { text: 'and the weekend?' });
  const again = await until(async () => {
    const x = await ended(session.id);
    return x.turns.length === 2 && x;
  });
  assert.equal(again.forLater, undefined);
  assert.equal(again.state, 'review');
});

test('takeCrewBlock keeps forLater', () => {
  const p = { blocks: [{ type: 'hero', title: 'Weekly digest' }, { type: 'crew', forLater: true }] };
  assert.deepEqual(takeCrewBlock(p), { remember: [], forLater: true });
});

test('crewStats: a member’s track record counts jobs, finished (without quiet check-ins or stops), check-ins reported, questions, follow-ups and spend', () => {
  const now = new Date('2026-10-27T15:00:00').getTime();
  const at = (d) => now - d * 864e5;
  const hero = (status) => ({ blocks: [{ type: 'hero', title: 't', status }] });
  const turn = (o = {}) => ({ status: 'done', startedAt: o.at, endedAt: o.at + 60_000, presentation: hero(o.hero || 'done'), stats: o.cost === undefined ? { inputTokens: 1000, outputTokens: 500 } : { costUsd: o.cost }, activity: o.activity || [], ...o.t });
  const job = (kind, d, o = {}) => ({ id: `s${Math.random()}`, crew: { id: 'ada', job: kind }, agent: o.agent || 'claude', createdAt: at(d), state: o.state || 'review', archived: !!o.archived, ...(o.pr && { pr: { state: o.pr } }), turns: o.turns || [turn({ at: at(d), ...o })] });
  const sessions = [
    job('checkin', 1, { cost: 0.1, t: { quiet: true }, state: 'done', archived: true }),
    job('checkin', 1, { cost: 0.1, state: 'done', archived: true }), // older quiet check-in: no flag, archived and done
    job('checkin', 2, { cost: 0.2 }), // reported
    job('task', 3, { cost: 0.5, hero: 'blocked', activity: [{ kind: 'ask', label: 'Needs your OK to run npm publish' }] }),
    job('task', 4, { cost: 0.4, pr: 'merged', turns: [turn({ at: at(4), cost: 0.3, t: { presentation: { blocks: [{ type: 'hero', status: 'done' }, { type: 'question', question: 'Which?' }] } } }), turn({ at: at(4), cost: 0.1 }), turn({ at: at(4), cost: 0, t: { by: undefined } })] }),
    job('mention', 5, { cost: 0.2, t: { status: 'stopped' } }),
    job('task', 40, { cost: 9 }), // before the range
  ];
  const { members: [r] } = crewStats([{ id: 'ada', name: 'Ada', createdAt: at(60) }], () => sessions, { days: 30, now });
  assert.equal(r.jobs, 6);
  assert.deepEqual(r.kinds, { checkin: 3, task: 2, mention: 1, delegated: 0, trigger: 0 });
  assert.equal(r.checkins, 3);
  assert.equal(r.quiet, 2);
  assert.equal(r.counted, 3); // the reported check-in and the two tasks
  assert.equal(r.done, 2);
  assert.equal(r.blocked, 1);
  assert.equal(r.stopped, 1);
  assert.equal(r.approvals, 1);
  assert.equal(r.questions, 1);
  assert.equal(r.followups, 1); // the answer to its question isn't one
  assert.equal(r.followedUp, 1);
  assert.deepEqual(r.prs, { merged: 1, open: 0 });
  assert.equal(r.cost, 1.5);
  assert.equal(r.priced, 6);
  assert.equal(r.daily.length, 30);
  const d1 = r.daily.find((d) => d.date === new Date(at(1)).toLocaleDateString('sv'));
  assert.deepEqual([d1.done, d1.quiet], [0, 2]);
});

test('crewStats: tokens when the harness has no price, summaries for a member on another machine', () => {
  const now = Date.now();
  const s = { crew: { id: 'q', job: 'task' }, agent: 'codex', createdAt: now - 1000, state: 'review', turns: [{ status: 'done', startedAt: now - 1000, endedAt: now, stats: { inputTokens: 3000, outputTokens: 1000 }, presentation: { blocks: [] } }] };
  const [local] = crewStats([{ id: 'q', name: 'Quill' }], () => [s], { now }).members;
  assert.equal(local.priced, 0);
  assert.equal(local.tokens, 4000);
  assert.deepEqual(local.unpricedAgents, ['codex']);
  const [remote] = crewStats([{ id: 'q', name: 'Quill', machine: 'm1' }], () => [{ crew: { id: 'q', job: 'task' }, createdAt: now - 1000, state: 'review', status: 'partial', followups: 2 }], { now }).members;
  assert.equal(remote.remote, true);
  assert.equal(remote.partial, 1);
  assert.equal(remote.followups, 2);
  const [none] = crewStats([{ id: 'z', name: 'Zed' }], () => [], { now }).members;
  assert.equal(none.jobs, 0);
});

test('crewStats: where a member’s usage went: per kind, per day, its heaviest jobs, its share of everything and of a plan window', () => {
  const now = new Date('2026-10-27T15:00:00').getTime();
  const H = 3600_000;
  const turn = (at, tokens, cost) => ({ status: 'done', startedAt: at, endedAt: at + 60_000, stats: { inputTokens: tokens - 100, outputTokens: 100, ...(cost !== undefined && { costUsd: cost }) }, presentation: { blocks: [{ type: 'hero', status: 'done' }] } });
  const job = (id, kind, at, tokens, o = {}) => ({ id, title: id, agent: 'claude', crew: { id: 'scout', job: kind }, createdAt: at, state: o.quiet ? 'done' : 'review', archived: !!o.quiet, turns: [{ ...turn(at, tokens, 0.1), ...(o.quiet && { quiet: true }) }] });
  const mine = [job('c1', 'checkin', now - 2 * H, 30_000, { quiet: true }), job('c2', 'checkin', now - 1 * H, 40_000), job('t1', 'task', now - 3 * 864e5, 100_000), job('w1', 'event', now - 3 * H, 5_000)];
  const yours = { id: 'y1', agent: 'claude', createdAt: now - 4 * H, turns: [turn(now - 4 * H, 75_000, 0.5)] };
  const budget = {
    state: { claude: { default: { windows: { five_hour: { used: 0.4, resetsAt: now + H, ms: 5 * H }, seven_day: { used: 0.6, resetsAt: now + 2 * 864e5, ms: 7 * 864e5 } } } } },
    view: () => [{ account: 'default', windows: [{ id: 'five_hour', label: '5-hour', used: 0.4, resetsAt: now + H }, { id: 'seven_day', label: 'Weekly', used: 0.6, resetsAt: now + 2 * 864e5 }] }],
  };
  const st = crewStats([{ id: 'scout', name: 'Scout', createdAt: now - 60 * 864e5 }], () => mine, { now, sessions: [...mine, yours], budget });
  const [r] = st.members;
  assert.equal(r.tokens, 175_000);
  assert.deepEqual(r.byKind.checkin, { runs: 2, tokens: 70_000, cost: 0.2, quiet: 1 });
  assert.equal(r.byKind.trigger.runs, 1);
  assert.equal(r.byKind.task.tokens, 100_000);
  assert.deepEqual(r.top.map((j) => j.id), ['t1', 'c2', 'c1', 'w1']);
  assert.equal(r.daily.at(-1).tokens, 75_000);
  assert.equal(r.span, 30);
  assert.deepEqual(st.all, { tokens: 250_000, cost: 0.9 });
  // The 5-hour window started 4h ago: your task (75k) and the three jobs of today (75k).
  const five = st.windows.find((w) => w.id === 'five_hour');
  assert.equal(five.tokens, 150_000);
  assert.deepEqual(five.members, { scout: 75_000 });
  assert.equal(st.windows.find((w) => w.id === 'seven_day').members.scout, 175_000);
});
