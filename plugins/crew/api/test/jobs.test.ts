// The rail's hover card (v1 test/crew-jobs.test.js): which jobs it lists, in what order, and how
// rows hold still while it's up. The ranking is the Crew section's: both read jobs.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byUrgency, CARD_ROWS, cardJobs, headingForCard, holdRows, jobMark, jobRank, standing, stepRow } from '../src/index.ts';
import type { JobLike } from '../src/index.ts';

type J = JobLike & { crew?: { job: string } };
const job = (id: string, state: string, extra: Partial<J> = {}): J => ({ id, state, updatedAt: 1, ...extra });
const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

test('the order: asking you, working, an unread report, then finished, newest first', () => {
  const jobs = [job('old', 'review', { updatedAt: 1 }), job('new', 'review', { updatedAt: 9 }), job('report', 'review', { unread: true }), job('run', 'running'), job('ask', 'waiting')];
  assert.deepEqual(ids(cardJobs({ jobs, sent: [] })), ['ask', 'run', 'report', 'new', 'old']);
  assert.deepEqual(ids([...jobs].sort(byUrgency)), ['ask', 'run', 'report', 'new', 'old'], 'the section sorts by the same rule');
});

test('the card lists every job the face counts, whatever kind it is', () => {
  const jobs = [job('checkin', 'running', { crew: { job: 'checkin' } }), job('yours', 'running', { crew: { job: 'task' } }), job('tagged', 'running', { crew: { job: 'mention' } })];
  assert.deepEqual(ids(cardJobs({ jobs, sent: [] })).sort(), ['checkin', 'tagged', 'yours']);
});

test('a job you sent shows with the working ones until its real one replaces it', () => {
  const sent = [job('pending-crew-1', 'running', { pending: true })];
  assert.deepEqual(ids(cardJobs({ jobs: [job('ask', 'waiting'), job('old', 'review')], sent })), ['ask', 'pending-crew-1', 'old']);
  assert.equal(jobMark(sent[0] ?? job('x', '')), 'live');
});

test('marked done or archived: only in the thread, unless it runs or asks again', () => {
  const jobs = [job('done', 'done'), job('kept', 'review', { archived: true }), job('back', 'running', { archived: true }), job('asks', 'waiting', { archived: true })];
  assert.deepEqual(ids(cardJobs({ jobs, sent: [] })), ['asks', 'back']);
  assert.equal(standing(job('done', 'done')), false);
});

test('a job with no time sorts without breaking the order', () => {
  const a: J = { id: 'a', state: 'review' };
  assert.deepEqual(ids(cardJobs({ jobs: [a, job('b', 'review', { updatedAt: 5 })], sent: [] })), ['b', 'a']);
});

test('the marker comes from the rank', () => {
  assert.equal(jobMark(job('a', 'waiting')), 'asks');
  assert.equal(jobMark(job('a', 'running')), 'live');
  assert.equal(jobMark(job('a', 'review', { unread: true })), 'unread');
  assert.equal(jobMark(job('a', 'review')), '');
  assert.equal(jobRank(job('a', 'done')), 3);
});

const none = (): boolean => false;

test('the first paint takes the top rows, up to the cap', () => {
  const fresh = Array.from({ length: 9 }, (_, i) => `j${i}`);
  assert.deepEqual(holdRows([], fresh, none), fresh.slice(0, CARD_ROWS));
});

test('rows hold their places when the ranking changes under them', () => {
  assert.deepEqual(holdRows(['a', 'b', 'c'], ['c', 'b', 'a'], none), ['a', 'b', 'c']);
});

test('a job that drops off the list keeps its row: it finished, the marker changes in place', () => {
  assert.deepEqual(holdRows(['a', 'b', 'c'], ['a', 'c'], none), ['a', 'b', 'c']);
});

test('a newcomer goes last, and only while there is room', () => {
  assert.deepEqual(holdRows(['a', 'b'], ['new', 'a', 'b'], none), ['a', 'b', 'new']);
  const full = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(holdRows(full, ['new', ...full], none), full);
});

test('a placeholder hands its place to the job that replaced it', () => {
  const gone = (id: string): boolean => id === 'pending';
  assert.deepEqual(holdRows(['a', 'pending', 'c'], ['real', 'a', 'c'], gone), ['a', 'real', 'c']);
});

test('a deleted job with nothing to replace it keeps its place until the card closes', () => {
  const gone = (id: string): boolean => id === 'b';
  assert.deepEqual(holdRows(['a', 'b', 'c'], ['a', 'c'], gone), ['a', 'b', 'c']);
});

test('heading for the card: a steep path counts, going along the rail does not', () => {
  assert.equal(headingForCard(0, 96), false, 'straight down the rail');
  assert.equal(headingForCard(1, 0), false, 'a pixel of jitter');
  assert.equal(headingForCard(-30, 10), false, 'away from the card');
  assert.equal(headingForCard(20, 112), true, 'steep, to a low row near the rail');
  assert.equal(headingForCard(10, -40), true, 'up works too');
  assert.equal(headingForCard(4, 96), false, 'a drift while going down the rail');
});

test('the arrow keys stop at the ends and leave other keys alone', () => {
  assert.equal(stepRow('ArrowDown', 0, 3), 1);
  assert.equal(stepRow('ArrowDown', 2, 3), 2);
  assert.equal(stepRow('ArrowUp', 1, 3), 0);
  assert.equal(stepRow('ArrowUp', 0, 3), 0);
  assert.equal(stepRow('Home', 2, 3), 0);
  assert.equal(stepRow('End', 0, 3), 2);
  assert.equal(stepRow('Enter', 0, 3), null);
});
