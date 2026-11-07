// The rail's pick, on the page's own code over a stub DOM (as crew-needs.test.js): what the list
// holds under it, when it clears, and what New task sends. Clicks and the chip: qa/scenarios/web.md WEB-32i.
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
// Wide: side by side, where the crew rail is. Stacked is one line away (the `wide` flag).
let wide = true;
globalThis.matchMedia = (q) => ({ get matches() { return /min-width/.test(q) && wide; }, addEventListener() {}, addListener() {} });
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
const { expand, groups, reveal } = await import('../web/js/features/feed.js');
const { addressedTo, crewPick, inPick, memberJobs, memberState, openMember, pickedPrompt, setCrewPick } = await import('../web/js/features/crew.js');

const ada = { id: 'adaada', name: 'Ada', log: [] };
const bob = { id: 'bobbob', name: 'Bob', log: [] };
let at = 0;
const put = (id, over = {}) => S.sessions.set(id, { id, title: id, state: 'review', createdAt: ++at, updatedAt: at, ...over });
const job = (id, who = ada, kind = 'task', over = {}) => put(id, { crew: { id: who.id, job: kind }, ...over });
const ids = (l) => l.map((s) => s.id);
const listed = (g = groups()) => Object.values(g).flatMap(ids).sort();

beforeEach(() => {
  wide = true;
  S.sessions.clear();
  S.open.clear();
  S.folded.clear();
  S.filter = 'all';
  S.crewOpen = null;
  S.crewPick = null;
  S.config = { ...S.config, crew: [ada, bob], projects: [] };
});

test('with no pick the list is as it was', () => {
  put('mine');
  job('sent');
  job('helping', ada, 'delegated');
  assert.deepEqual(listed(), ['mine', 'sent']);
  assert.equal(crewPick(), null);
});

test('a pick shows only that member’s jobs, of every kind, in the normal sections', () => {
  put('mine', { state: 'waiting' });
  job('other', bob);
  job('checkin', ada, 'checkin', { state: 'done' });
  job('sent', ada, 'task', { state: 'running' });
  job('helping', ada, 'delegated');
  job('mention', ada, 'mention', { state: 'done' });
  job('later', ada, 'event', { forLater: { at: 1 } });
  job('old', ada, 'task', { archived: true });
  S.crewPick = ada.id;
  const g = groups();
  assert.deepEqual(ids(g.working), ['sent']);
  assert.deepEqual(ids(g.needs), ['helping']);
  assert.deepEqual(ids(g.done).sort(), ['checkin', 'mention']);
  assert.deepEqual(ids(g.forLater), ['later']);
  assert.deepEqual(ids(g.archived), ['old']);
  assert.deepEqual(listed(groups('all', null)), ['checkin', 'later', 'mine', 'old', 'other', 'sent']); // null: everything
});

test('a job under its member becomes a list row with a pick, and leaves memberJobs: never two cards', () => {
  job('helping', ada, 'delegated', { state: 'running' });
  assert.deepEqual(ids(memberJobs(ada, memberState(ada), 9).list), ['helping']);
  S.crewPick = ada.id;
  assert.deepEqual(ids(groups().working), ['helping']);
  assert.deepEqual(ids(memberJobs(ada, memberState(ada), 9).list), []);
});

test('a pick ANDs with the project filter, and what the filter hides stays under its member', () => {
  S.config.projects = [{ id: 'p1', name: 'one', path: '/one', color: 'slate' }];
  job('in', ada, 'delegated', { projectId: 'p1', cwd: '/one', state: 'running' });
  job('out', ada, 'delegated', { projectId: 'p2', cwd: '/two', state: 'running' });
  put('mine', { projectId: 'p1', cwd: '/one' });
  S.crewPick = ada.id;
  S.filter = 'p1';
  assert.deepEqual(listed(), ['in']);
  assert.deepEqual(ids(memberJobs(ada, memberState(ada), 9).list), ['out']);
});

test('stacked, or with no rail, a saved pick is ignored and kept', () => {
  put('mine');
  job('sent');
  S.crewPick = ada.id;
  wide = false;
  assert.equal(crewPick(), null);
  assert.deepEqual(listed(), ['mine', 'sent']);
  assert.ok(inPick(S.sessions.get('mine')));
  assert.equal(S.crewPick, ada.id);
  wide = true;
  assert.equal(crewPick(), ada.id);
});

test('a removed member counts as All; before the config lands the pick holds', () => {
  put('mine');
  S.crewPick = 'gonegone';
  assert.equal(crewPick(), null);
  assert.deepEqual(listed(), ['mine']);
  const { crew, ...rest } = S.config;
  S.config = rest;
  assert.equal(crewPick(), 'gonegone'); // no flash of the whole list on a reload
  assert.deepEqual(listed(), []);
});

// The list repaints past what the stub DOM can do; the pick is settled before that.
const opened = async (how, id) => {
  try {
    await how(id);
  } catch {}
};

test('opening a task the pick hides clears it; one it shows leaves it', async () => {
  put('mine');
  job('sent');
  put('sub', { parentId: 'sent' });
  S.crewPick = ada.id;
  await opened(reveal, 'sent');
  assert.equal(S.crewPick, ada.id);
  await opened(reveal, 'sub'); // a subagent goes with its lead
  assert.equal(S.crewPick, ada.id);
  await opened(reveal, 'mine');
  assert.equal(S.crewPick, null);
  S.crewPick = ada.id;
  await opened(expand, 'mine'); // straight to expand: a terminal session, a Ship link
  assert.equal(S.crewPick, null);
});

test('another member’s thread clears the pick; its own keeps it', () => {
  S.crewPick = ada.id;
  try { openMember(ada.id); } catch {}
  assert.equal(S.crewPick, ada.id);
  try { openMember(bob.id); } catch {}
  assert.equal(S.crewPick, null);
});

test('setCrewPick is saved under wisp.crewPick', () => {
  const was = localStorage.setItem;
  const saved = [];
  localStorage.setItem = (k, v) => saved.push([k, v]);
  setCrewPick(ada.id);
  setCrewPick(null);
  localStorage.setItem = was;
  assert.deepEqual(saved, [['wisp.crewPick', JSON.stringify(ada.id)], ['wisp.crewPick', 'null']]);
});

test('New task with a pick sends the same thing as typing @Ada', () => {
  const out = pickedPrompt('  Write the notes ', ada);
  assert.equal(out, '@[Ada](crew:adaada) Write the notes');
  const to = addressedTo(out);
  assert.deepEqual(to.members, [ada]);
  assert.equal(to.rest, 'Write the notes');
  assert.deepEqual(addressedTo('@Ada Write the notes').members, to.members);
});

test('a typed @name wins over the pick, and a slash command is not a job', () => {
  assert.equal(pickedPrompt('@Bob have a look', ada), null);
  assert.equal(pickedPrompt('@Ada have a look', ada), null); // already addressed: not twice
  assert.equal(pickedPrompt('@[Bob](crew:bobbob) have a look', ada), null);
  assert.equal(pickedPrompt('/draft later', ada), null);
  assert.equal(pickedPrompt('plain', null), null); // × took it off
  assert.equal(pickedPrompt('a mention of @Bob further in', ada), '@[Ada](crew:adaada) a mention of @Bob further in');
});
