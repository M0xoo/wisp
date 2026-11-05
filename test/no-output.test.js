// *No output for 12 min* in the working panel: when a run counts as quiet (web/js/no-output.js,
// DOM-free) and the stamp the server puts on a call that finished (server/runner.js stepOutput).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, lastOutputAt, NO_OUTPUT_MS, noOutputLine, QUIET_STREAM_MS } from '../web/js/no-output.js';
import { stepOf, stepOutput } from '../server/runner.js';

const MIN = 60_000;
const START = 1_000_000;
const turn = (over = {}) => ({ id: 'turn1', status: 'running', startedAt: START, activity: [], ...over });
const task = (over = {}) => ({ id: 's1', state: 'running', turns: [], ...over });
const at = (min, sec = 0) => START + min * MIN + sec * 1000;

test('the threshold is 12 minutes', () => {
  assert.equal(NO_OUTPUT_MS, 12 * 60_000);
});

test('lastOutputAt: the start with nothing else, then the newest step or output stamp', () => {
  assert.equal(lastOutputAt(turn()), START);
  assert.equal(lastOutputAt({ startedAt: START }), START, 'a turn with no activity field');
  assert.equal(lastOutputAt(turn({ activity: [{ t: START + 5 }, { t: START + 9 }] })), START + 9);
  // Two calls overlap: the older step's result came in last.
  assert.equal(lastOutputAt(turn({ activity: [{ t: START + 5, outAt: START + 50 }, { t: START + 9 }] })), START + 50);
  assert.equal(lastOutputAt(turn({ activity: [{ t: START + 5, outAt: START + 8 }, { t: START + 9, outAt: START + 7 }] })), START + 9);
  assert.equal(lastOutputAt(turn({ activity: [{ kind: 'text' }] })), START, 'a step with no stamp is no time');
});

test('noOutputLine: nothing under 12 minutes, the words from there on', () => {
  const t = turn();
  const s = task();
  assert.equal(noOutputLine(s, t, at(11, 59)), '');
  assert.equal(noOutputLine(s, t, at(12)), 'No output for 12 min');
  assert.equal(noOutputLine(s, t, at(12, 59)), 'No output for 12 min', 'floored');
  assert.equal(noOutputLine(s, t, at(13)), 'No output for 13 min');
  assert.equal(noOutputLine(s, t, at(59, 59)), 'No output for 59 min');
});

test('noOutputLine: hours from 60 minutes', () => {
  const t = turn();
  const s = task();
  assert.equal(noOutputLine(s, t, at(60)), 'No output for 1 h');
  assert.equal(noOutputLine(s, t, at(61)), 'No output for 1 h 1 min');
  assert.equal(noOutputLine(s, t, at(65, 30)), 'No output for 1 h 5 min');
  assert.equal(noOutputLine(s, t, at(120)), 'No output for 2 h');
  assert.equal(noOutputLine(s, t, at(135)), 'No output for 2 h 15 min');
});

test('noOutputLine counts from the last thing that happened, and clears when something new does', () => {
  const t = turn({ activity: [{ t: at(1), kind: 'run', call: 'a' }] });
  const s = task();
  const now = at(14);
  assert.equal(noOutputLine(s, t, now), 'No output for 13 min');
  t.activity[0].outAt = at(13); // what `update` assigns onto the known step
  assert.equal(noOutputLine(s, t, now), '');
  t.activity.push({ t: at(14), kind: 'text' });
  assert.equal(noOutputLine(s, t, at(26)), 'No output for 12 min');
});

test('noOutputLine: only a running turn', () => {
  for (const status of ['done', 'error', 'stopped', 'held']) assert.equal(noOutputLine(task(), turn({ status }), at(30)), '', status);
});

test('noOutputLine: a task asking you something shows no line', () => {
  assert.equal(noOutputLine(task({ ask: { id: 'q', question: 'Which?' } }), turn(), at(30)), '');
  assert.equal(noOutputLine(task({ state: 'waiting' }), turn(), at(30)), '');
});

test('noOutputLine: no line while a delegate of the turn runs', () => {
  const t = turn({ delegations: [{ sessionId: 'c1', turnId: 'ct1' }, { sessionId: 'c2', turnId: 'ct2' }] });
  const child = (id, status) => ({ turns: [{ id, status }] });
  const now = at(30);
  assert.equal(noOutputLine(task({ childSessions: { c1: child('ct1', 'done'), c2: child('ct2', 'running') } }), t, now), '', 'one still running');
  assert.equal(noOutputLine(task({ childSessions: { c1: child('ct1', 'done') } }), t, now), '', 'one not on the page yet counts as running');
  assert.equal(noOutputLine(task({ childSessions: { c1: child('ct1', 'done'), c2: { turns: [] } } }), t, now), '', 'its turn not there yet');
  assert.equal(noOutputLine(task(), t, now), '', 'no childSessions at all');
  assert.equal(noOutputLine(task({ childSessions: { c1: child('ct1', 'done'), c2: child('ct2', 'error') } }), t, now), 'No output for 30 min', 'all over');
  assert.equal(noOutputLine(task({ childSessions: { c1: child('ct1', 'running') } }), turn(), now), 'No output for 30 min', 'a child that is not this turn’s');
});

test('noOutputLine: no line while a built-in subagent call is open', () => {
  const open = { t: at(1), kind: 'agent', call: 'task1', label: 'Delegating: read the repo' };
  assert.equal(noOutputLine(task(), turn({ activity: [open] }), at(30)), '');
  assert.equal(noOutputLine(task(), turn({ activity: [{ ...open, outAt: at(2) }] }), at(30)), 'No output for 28 min', 'its result came in');
  assert.equal(noOutputLine(task(), turn({ activity: [{ ...open, output: 'done' }] }), at(30)), 'No output for 29 min', 'output from before outAt');
  assert.equal(noOutputLine(task(), turn({ activity: [{ ...open, kind: 'run' }] }), at(30)), 'No output for 29 min', 'a command waits like any other');
  const { call, ...noCall } = open;
  assert.equal(noOutputLine(task(), turn({ activity: [noCall] }), at(30)), 'No output for 29 min', 'a harness with no call id can’t say it’s open');
});

test('freshness: a page that never lost its stream can trust its copy, even before hello', () => {
  const f = freshness();
  assert.equal(f.ok('s1', 5), true);
  f.hello(10);
  assert.equal(f.ok('s1', 20), true);
});

test('freshness: from a drop until the task is read again after hello', () => {
  const f = freshness();
  f.hello(0);
  f.read('s1');
  f.read('s2');
  f.drop();
  assert.equal(f.ok('s1', 1), false, 'the clock runs, the events don’t');
  f.read('s1');
  assert.equal(f.ok('s1', 1), false, 'a read while it’s down can still miss what follows');
  f.hello(2);
  assert.equal(f.ok('s1', 3), false, 'hello alone: the phone ticks before its refetch');
  f.read('s1');
  assert.equal(f.ok('s1', 3), true);
  assert.equal(f.ok('s2', 3), false, 'each task on its own');
});

test('freshness: a stream that went quiet looks open but says nothing', () => {
  const f = freshness();
  f.hello(1000);
  assert.equal(f.ok('s1', 1000 + QUIET_STREAM_MS), true);
  assert.equal(f.ok('s1', 1001 + QUIET_STREAM_MS), false, 'a laptop just awake, its stream not yet known dead');
  f.heard(2000 + QUIET_STREAM_MS);
  assert.equal(f.ok('s1', 2001 + QUIET_STREAM_MS), true, 'the server’s ping came');
  assert.ok(QUIET_STREAM_MS > 2 * 25_000, 'longer than two of the server’s pings');
});

test('stepOutput: stamps a found step when its result comes in', () => {
  const step = stepOf({ type: 'tool', kind: 'run', id: 'c1', label: 'Running', detail: 'ls' });
  const activity = [step];
  const before = Date.now();
  assert.equal(stepOutput(activity, { id: 'c1', text: 'a.txt\n' }), step);
  assert.equal(step.output, 'a.txt');
  assert.ok(step.outAt >= before && step.outAt <= Date.now());
});

test('stepOutput: a call that returned nothing still counts, and keeps what it had', () => {
  const quiet = stepOf({ type: 'tool', kind: 'run', id: 'c1', label: 'Waiting', detail: 'until x; do sleep 5; done' });
  assert.equal(stepOutput([quiet], { id: 'c1', text: '' }), quiet, 'the caller emits the update');
  assert.equal(quiet.output, undefined, 'no empty output on the step');
  assert.equal(typeof quiet.outAt, 'number');
  const spaced = stepOf({ type: 'tool', kind: 'tool', id: 'c2', label: 'x' });
  assert.equal(stepOutput([spaced], { id: 'c2', text: ' \n' }), spaced);
  assert.equal(spaced.output, undefined);
  const had = stepOf({ type: 'tool', kind: 'run', id: 'c3', label: 'x', output: 'first' });
  assert.equal(stepOutput([had], { id: 'c3', text: '' }), had);
  assert.equal(had.output, 'first', 'existing output is untouched');
  assert.equal(typeof had.outAt, 'number');
});

test('stepOutput: read and edit steps, unknown calls and id-less events stay as they were', () => {
  for (const kind of ['read', 'edit']) {
    const step = stepOf({ type: 'tool', kind, id: 'c1', label: 'x' });
    assert.equal(stepOutput([step], { id: 'c1', text: 'contents' }), null, kind);
    assert.equal(step.outAt, undefined);
    assert.equal(step.output, undefined);
  }
  assert.equal(stepOutput([], { id: 'gone', text: 'x' }), null);
  assert.equal(stepOutput([{ kind: 'run', call: '1' }], { text: 'x' }), null);
});
