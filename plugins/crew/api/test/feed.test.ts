// Where a crew job sits in the list and the rail's pick (v1 test/crew-needs.test.js and
// test/crew-pick.test.js, which drove the page's modules over a stub DOM; the same cases on feed.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addressedTo, cardJobs, crewPick, memberJobs, memberState, NeedsTracker, pickAfterOpen, pickAfterThread, pickCard, pickedPrompt, pickFace, PICK_KEY, revealSection, sections, underMember } from '../src/index.ts';
import type { FeedCtx, FeedRow } from '../src/index.ts';

const ada = { id: 'adaada', name: 'Ada' };
const bob = { id: 'bobbob', name: 'Bob' };
const crew = [ada, bob];
let at = 0;
const rows = new Map<string, FeedRow>();
let c: FeedCtx & { crewOpen: string | null; pinned: Set<string>; open: Set<string> };
const put = (id: string, over: Partial<FeedRow> = {}): FeedRow => {
  const s: FeedRow = { id, title: id, state: 'review', createdAt: ++at, updatedAt: at, ...over };
  rows.set(id, s);
  return s;
};
const job = (id: string, over: Partial<FeedRow> = {}, who = ada, kind = 'delegated'): FeedRow => put(id, { crew: { id: who.id, job: kind }, ...over });
const ids = (l: readonly { id: string }[]): string[] => l.map((s) => s.id);
const groups = (o: Partial<FeedCtx> = {}) => sections(rows.values(), { ...c, ...o });
const jobs = (m = ada, max = 9): string[] => ids(memberJobs(m, memberState(m, rows.values()), c, max).list);
const listed = (o: Partial<FeedCtx> = {}): string[] => Object.values(groups(o)).flatMap(ids).sort();
const row = (id: string): FeedRow => rows.get(id) ?? put(id);

beforeEach(() => {
  rows.clear();
  c = { filter: 'all', pick: null, open: new Set(), pinned: new Set(), crewOpen: null, has: (id) => crew.some((m) => m.id === id), needs: new NeedsTracker() };
});

// --- crew-needs ---------------------------------------------------------------------------------

test('a crew job asking you or with an unread report is in Needs you, sorted with your tasks', () => {
  put('mine', { state: 'waiting' });
  job('report', { unread: true });
  job('asks', { state: 'waiting' });
  put('read');
  assert.deepEqual(ids(groups().needs), ['asks', 'mine', 'read', 'report']); // waiting first, then the latest
});

test('crew jobs stay out of Working and Done, and a read, sent or scheduled one out of Needs you', () => {
  job('running', { state: 'running' });
  job('done', { state: 'done' });
  job('read');
  job('sent', { state: 'waiting', pending: true });
  job('later', { unread: true, later: [{ at: Date.now() + 1000 }] });
  const g = groups();
  for (const list of [g.needs, g.working, g.done, g.scheduled]) assert.deepEqual(ids(list), []);
});

test('a job for For later keeps that section, not Needs you', () => {
  job('saved', { unread: true, forLater: { at: 1, by: 'crew' } });
  const g = groups();
  assert.deepEqual(ids(g.needs), []);
  assert.deepEqual(ids(g.forLater), ['saved']);
});

test('a job in Needs you leaves the list under its member; the others stay', () => {
  job('asks', { state: 'waiting' });
  job('report', { unread: true });
  job('read');
  job('running', { state: 'running' });
  groups();
  assert.deepEqual(jobs().sort(), ['read', 'running']);
  const st = memberState(ada, rows.values());
  assert.equal(st.asks, true, 'the member still says it asks');
  assert.equal(st.unread, 1, 'and that a report is unread');
});

test('the "more" count under a member counts only what the list under it leaves out', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e']) job(id);
  job('asks', { state: 'waiting' });
  const { list, more } = memberJobs(ada, memberState(ada, rows.values()), c, 3);
  assert.equal(list.length, 3);
  assert.equal(more, 2);
});

test('a report opened from Needs you keeps its row until it closes', () => {
  job('report', { unread: true });
  assert.deepEqual(ids(groups().needs), ['report']);
  c.open.add('report');
  row('report').unread = false;
  assert.deepEqual(ids(groups().needs), ['report']);
  assert.deepEqual(jobs(), [], 'one card, one place');
  c.open.delete('report');
  assert.deepEqual(ids(groups().needs), []);
  assert.deepEqual(jobs(), ['report']);
});

test('a read job opened from under its member stays there', () => {
  job('read');
  c.open.add('read');
  assert.deepEqual(ids(groups().needs), []);
  assert.deepEqual(jobs(), ['read']);
});

test('an open job that moves on leaves Needs you at once: answered, done or archived', () => {
  for (const [id, change] of [['answered', { state: 'running' }], ['done', { state: 'done' }], ['archived', { archived: true }]] as const) {
    job(id, { state: 'waiting' });
    c.open.add(id);
    assert.ok(ids(groups().needs).includes(id));
    Object.assign(row(id), change);
    const g = groups();
    for (const list of [g.needs, g.working, g.done]) assert.ok(!ids(list).includes(id), `${id} is out`);
  }
});

test('a project filter applies, and a job it hides stays under its member', () => {
  job('here', { state: 'waiting', projectId: 'p1' });
  job('there', { state: 'waiting', projectId: 'p2' });
  assert.equal(groups({ filter: 'all' }).needs.length, 2, 'every project, whatever the filter');
  c.filter = 'p1';
  assert.deepEqual(ids(groups().needs), ['here']);
  assert.deepEqual(jobs(), ['there']);
  assert.equal(groups({ filter: 'all' }).needs.length, 2);
});

test('reveal lands on Needs you for a job there, on Crew for the rest', () => {
  job('asks', { state: 'waiting' });
  job('read');
  assert.equal(revealSection(row('asks'), c), 'secNeeds');
  assert.equal(revealSection(row('read'), c), 'secCrew');
});

test('a job not for another task was never under its member', () => {
  put('sent', { crew: { id: ada.id, job: 'task' }, unread: true });
  assert.equal(c.needs.inNeeds(row('sent'), c), false);
  assert.equal(underMember(row('sent'), c.has), false);
  assert.deepEqual(ids(groups().needs), ['sent']);
});

test('the rail’s hover card still lists a job that sits in Needs you: the face counts it', () => {
  job('asks', { state: 'waiting' });
  job('report', { unread: true });
  job('working', { state: 'running' });
  assert.deepEqual(jobs(), ['working'], 'the section leaves them to Needs you');
  assert.deepEqual(ids(cardJobs(memberState(ada, rows.values()))), ['asks', 'working', 'report']);
});

// --- crew-pick ----------------------------------------------------------------------------------

test('with no pick the list is as it was', () => {
  put('mine');
  job('sent', {}, ada, 'task');
  job('helping');
  assert.deepEqual(listed(), ['mine', 'sent']);
  assert.equal(crewPick(null, { railOn: true, members: crew }), null);
});

test('a pick shows only that member’s jobs, of every kind, in the normal sections', () => {
  put('mine', { state: 'waiting' });
  job('other', {}, bob, 'task');
  job('checkin', { state: 'done' }, ada, 'checkin');
  job('sent', { state: 'running' }, ada, 'task');
  job('helping');
  job('mention', { state: 'done' }, ada, 'mention');
  job('later', { forLater: { at: 1 } }, ada, 'event');
  job('old', { archived: true }, ada, 'task');
  const g = groups({ pick: ada.id });
  assert.deepEqual(ids(g.working), ['sent']);
  assert.deepEqual(ids(g.needs), ['helping']);
  assert.deepEqual(ids(g.done).sort(), ['checkin', 'mention']);
  assert.deepEqual(ids(g.forLater), ['later']);
  assert.deepEqual(ids(g.archived), ['old']);
  assert.deepEqual(listed({ pick: null }), ['checkin', 'later', 'mine', 'old', 'other', 'sent']); // null: everything
});

test('a job under its member becomes a list row with a pick, and leaves memberJobs: never two cards', () => {
  job('helping', { state: 'running' });
  assert.deepEqual(jobs(), ['helping']);
  c.pick = ada.id;
  assert.deepEqual(ids(groups().working), ['helping']);
  assert.deepEqual(jobs(), []);
});

test('a pick ANDs with the project filter, and what the filter hides stays under its member', () => {
  job('in', { projectId: 'p1', state: 'running' });
  job('out', { projectId: 'p2', state: 'running' });
  put('mine', { projectId: 'p1' });
  c.pick = ada.id;
  c.filter = 'p1';
  assert.deepEqual(listed(), ['in']);
  assert.deepEqual(jobs(), ['out']);
});

test('stacked, or with no rail, a saved pick is ignored and kept; a removed member is All; before the crew lands it holds', () => {
  assert.equal(crewPick(ada.id, { railOn: false, members: crew }), null);
  assert.equal(crewPick(ada.id, { railOn: true, members: crew }), ada.id);
  assert.equal(crewPick('gonegone', { railOn: true, members: crew }), null);
  assert.equal(crewPick('gonegone', { railOn: true, members: undefined }), 'gonegone', 'no flash of the whole list on a reload');
});

test('opening a task the pick hides clears it; one it shows leaves it', () => {
  const mine = put('mine');
  const sent = job('sent', {}, ada, 'task');
  const sub = put('sub', { parentId: 'sent' });
  assert.equal(pickAfterOpen(ada.id, sent), ada.id);
  assert.equal(pickAfterOpen(ada.id, sub, sent), ada.id, 'a subagent goes with its lead');
  assert.equal(pickAfterOpen(ada.id, mine), null);
});

test('another member’s thread clears the pick; its own keeps it', () => {
  assert.equal(pickAfterThread(ada.id, ada.id), ada.id);
  assert.equal(pickAfterThread(ada.id, bob.id), null);
});

test('the hover card’s head and last row pick the member, from All or another pick, and never toggle', () => {
  assert.equal(pickCard(null, ada.id), ada.id, 'from All');
  assert.equal(pickCard(bob.id, ada.id), ada.id);
  assert.equal(pickCard(ada.id, ada.id), ada.id, 'the card says Open: a second click stays');
  assert.equal(pickFace(ada.id, ada.id), null, 'the face is the toggle');
  assert.equal(pickFace(null, ada.id), ada.id);
  assert.equal(PICK_KEY, 'wisp.crewPick');
});

test('New task with a pick sends the same thing as typing @Ada', () => {
  const out = pickedPrompt('  Write the notes ', ada, crew);
  assert.equal(out, '@[Ada](crew:adaada) Write the notes');
  const to = addressedTo(out, crew);
  assert.deepEqual(to.members, [ada]);
  assert.equal(to.rest, 'Write the notes');
  assert.deepEqual(addressedTo('@Ada Write the notes', crew).members, to.members);
});

test('a typed @name wins over the pick, and a slash command is not a job', () => {
  assert.equal(pickedPrompt('@Bob have a look', ada, crew), null);
  assert.equal(pickedPrompt('@Ada have a look', ada, crew), null); // already addressed: not twice
  assert.equal(pickedPrompt('@[Bob](crew:bobbob) have a look', ada, crew), null);
  assert.equal(pickedPrompt('/draft later', ada, crew), null);
  assert.equal(pickedPrompt('plain', null, crew), null); // × took it off
  assert.equal(pickedPrompt('a mention of @Bob further in', ada, crew), '@[Ada](crew:adaada) a mention of @Bob further in');
});
