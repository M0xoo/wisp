// The page's code (feed.js, crew.js) loaded in node over a stub DOM: which section a crew job for
// another task sits in, and that it's in one place at a time.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Anything the page's modules touch at load answers with something that takes any call.
const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
    set: () => true,
  });
globalThis.document = new Proxy({}, { get: (t, k) => (k === 'querySelector' ? () => any() : k === 'querySelectorAll' ? () => [] : any()) });
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.history = { pushState() {}, replaceState() {}, state: null };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '' });
globalThis.visualViewport = undefined;
globalThis.CSS = { escape: (x) => x };
// Node 20 has no navigator global (21+ does), and ui/kbd.js reads navigator.platform at load.
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '', clipboard: { writeText: async () => {} } };
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
for (const n of ['HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Image', 'BroadcastChannel'])
  globalThis[n] ||= class {
    constructor() {
      return any();
    }
    get value() {
      return '';
    }
    set value(v) {}
  };
globalThis.setInterval = () => 0; // the page's pollers would keep the test running
const { S } = await import('../web/js/core/state.js');
const { groups, reveal, sectionOpen } = await import('../web/js/features/feed.js');
const { inNeeds, memberJobs, memberState } = await import('../web/js/features/crew.js');

const ada = { id: 'ada', name: 'Ada', log: [] };
let at = 0;
const put = (id, over = {}) => S.sessions.set(id, { id, title: id, state: 'review', createdAt: ++at, updatedAt: at, ...over });
const job = (id, over = {}) => put(id, { crew: { id: 'ada', job: 'delegated' }, ...over });
const ids = (l) => l.map((s) => s.id);
const jobs = () => ids(memberJobs(ada, memberState(ada), 9).list);

beforeEach(() => {
  S.sessions.clear();
  S.open.clear();
  S.folded.clear();
  S.filter = 'all';
  S.crewOpen = null;
  S.config = { ...S.config, crew: [ada], projects: [] };
});

test('a crew job asking you or with an unread report is in Needs you, sorted with your tasks', () => {
  put('mine', { state: 'waiting' });
  job('report', { unread: true });
  job('asks', { state: 'waiting' });
  put('read');
  const { needs } = groups();
  assert.deepEqual(ids(needs), ['asks', 'mine', 'read', 'report']); // waiting first, then the latest
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
  const st = memberState(ada);
  assert.equal(st.asks, true, 'the member still says it asks');
  assert.equal(st.unread, 1, 'and that a report is unread');
});

test('the "more" count under a member counts only what the list under it leaves out', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e']) job(id);
  job('asks', { state: 'waiting' });
  const { list, more } = memberJobs(ada, memberState(ada), 3);
  assert.equal(list.length, 3);
  assert.equal(more, 2);
});

test('a report opened from Needs you keeps its row until it closes', () => {
  job('report', { unread: true });
  assert.deepEqual(ids(groups().needs), ['report']);
  S.open.add('report');
  S.sessions.get('report').unread = false;
  assert.deepEqual(ids(groups().needs), ['report']);
  assert.deepEqual(jobs(), [], 'one card, one place');
  S.open.delete('report');
  assert.deepEqual(ids(groups().needs), []);
  assert.deepEqual(jobs(), ['report']);
});

test('a read job opened from under its member stays there', () => {
  job('read');
  S.open.add('read');
  assert.deepEqual(ids(groups().needs), []);
  assert.deepEqual(jobs(), ['read']);
});

test('an open job that moves on leaves Needs you at once: answered, done or archived', () => {
  for (const [id, change] of [['answered', { state: 'running' }], ['done', { state: 'done' }], ['archived', { archived: true }]]) {
    job(id, { state: 'waiting' });
    S.open.add(id);
    assert.ok(ids(groups().needs).includes(id));
    Object.assign(S.sessions.get(id), change);
    const g = groups();
    for (const list of [g.needs, g.working, g.done]) assert.ok(!ids(list).includes(id), `${id} is out`);
  }
});

test('a project filter applies, and a job it hides stays under its member', () => {
  S.config.projects = [{ id: 'p1', name: 'one' }, { id: 'p2', name: 'two' }];
  job('here', { state: 'waiting', projectId: 'p1' });
  job('there', { state: 'waiting', projectId: 'p2' });
  assert.equal(groups('all').needs.length, 2, 'every project, whatever the filter');
  S.filter = 'p1';
  assert.deepEqual(ids(groups().needs), ['here']);
  assert.deepEqual(jobs(), ['there']);
  assert.equal(groups('all').needs.length, 2);
});

test('reveal lands on Needs you for a job there, on Crew for the rest', async () => {
  job('asks', { state: 'waiting' });
  job('read');
  S.folded.add('secNeeds').add('secCrew');
  groups();
  await reveal('asks').catch(() => {}); // what it opens needs a real page
  assert.equal(sectionOpen('secNeeds'), true);
  assert.equal(sectionOpen('secCrew'), false, 'Crew stays folded');
  S.open.clear();
  await reveal('read').catch(() => {});
  assert.equal(sectionOpen('secCrew'), true);
});

test('a job not for another task was never under its member', () => {
  put('sent', { crew: { id: 'ada', job: 'task' }, unread: true });
  assert.equal(inNeeds(S.sessions.get('sent')), false);
  assert.deepEqual(ids(groups().needs), ['sent']);
});
