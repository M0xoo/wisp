// This Mac on the page (web/js/machine-view.js): the chip, the rows, the 24 h numbers, read from a
// stub GET /machine in design/machine.md's shape (test/fixtures/machine.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationsLine, chipOf, dayStats, laterChoices, machineLabel, pauseChoices, reclaimRows, resText, size, spark, usingRows } from '../web/js/machine-view.js';
import { machineFixture } from './fixtures/machine.mjs';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('the pane is named for the OS wisp runs on', () => {
  assert.equal(machineLabel('darwin'), 'This Mac');
  assert.equal(machineLabel('win32'), 'This PC');
  assert.equal(machineLabel('linux'), 'This computer');
  assert.equal(machineLabel(undefined), 'This computer');
});

test('the chip shows only when it matters', () => {
  const calm = { memFreePct: 60, runs: 3, limits: { floor: 15 }, held: null };
  assert.equal(chipOf({ load: calm }), null, 'plenty free, nothing held: no chip');
  assert.equal(chipOf({}), null);
  const tight = chipOf({ load: { ...calm, memFreePct: 22 } });
  assert.equal(tight.text, '22% memory · 3 running', 'under floor + 10');
  assert.equal(tight.tone, 'warn');
  assert.equal(chipOf({ load: { ...calm, memFreePct: 12 } }).tone, 'bad', 'under the floor');
  const held = chipOf({ load: { ...calm, held: { kind: 'runs', why: 'Waiting for a run slot: 8 runs going, at most 8' } } });
  assert.equal(held.lead, '60%');
  assert.match(held.why, /run slot/);
  const now = Date.UTC(2026, 10, 7, 18, 0);
  const paused = chipOf({ load: calm, pausedUntil: now + 3600_000, now });
  assert.equal(paused.lead, 'Paused');
  assert.match(paused.text, /^Paused until /);
  assert.equal(chipOf({ load: calm, pausedUntil: now - 1, now }), null, 'a pause that ran out');
  assert.equal(chipOf({ load: calm, left: 2 }).text, '2 left behind');
  // /machine while paused: guard.held is 'paused', which reads as the pause, not as memory
  const m = { mem: { freePct: 60 }, guard: { held: 'paused', floor: 15, runs: 1, pausedUntil: now + 3600_000 } };
  assert.equal(chipOf({ load: m, pausedUntil: now + 3600_000, now }).lead, 'Paused');
  // /machine's own shape works too
  assert.equal(chipOf({ load: machineFixture() }).text, '12% memory · 9 running');
});

test('a row shows RAM only for a heavy running task', () => {
  assert.equal(resText({ state: 'running', res: { rss: 1.2 * GB, cpu: 40 } }), '1.2 GB');
  assert.equal(resText({ state: 'running' }), '', 'under the thresholds the server sends no res');
  assert.equal(resText({ state: 'review', res: { rss: 1.2 * GB } }), '', 'not once it stopped');
  assert.equal(size(340 * MB), '340 MB');
  assert.equal(size(21 * GB), '21 GB');
});

test("what's using it: tasks and crew members by RAM, crew jobs folded into their member", () => {
  const rows = usingRows(machineFixture());
  assert.deepEqual(rows.map((r) => r.key), ['t:t1', 'c:m1', 't:t2', 't:t3']);
  const sana = rows.find((r) => r.kind === 'crew');
  assert.deepEqual(sana.ids, ['j1', 'j2'], 'Stop and Later act on each job');
  assert.equal(sana.bytes, 820 * MB + 1.1 * GB);
  // jobs as ids works too
  const m = machineFixture({ crew: [{ id: 'm1', name: 'Sana', rss: 1, cpu: 1, jobs: ['j2'] }] });
  assert.deepEqual(usingRows(m).find((r) => r.kind === 'crew').ids, ['j2']);
  assert.deepEqual(usingRows({}), []);
});

test('free up space: safest groups first, leftovers last and marked for review', () => {
  const rows = reclaimRows(machineFixture());
  assert.deepEqual(rows.map((r) => r.kind), ['merged', 'done', 'crew', 'leftover']);
  assert.equal(rows[0].label, '25 folders of merged or closed PRs');
  assert.equal(rows.at(-1).safe, false);
  assert.deepEqual(reclaimRows({ reclaim: [{ kind: 'done', count: 0, bytes: 0, ids: [] }, { kind: 'nope', count: 3 }] }), [], 'empty and unknown groups are left out');
  assert.equal(reclaimRows({ reclaim: [{ kind: 'done', count: 1, bytes: 1, ids: ['a'] }] })[0].label, '1 folder of a Done task');
});

test('last 24 h: lowest free memory, most runs, time waited, disk freed', () => {
  const now = 10 * 3600_000 * 24;
  const p = (min, freePct, runs, held, gb) => ({ at: now - min * 60_000, freePct, cpu: 50, runs, held, worktreeBytes: gb * GB });
  const d = dayStats([p(25 * 60, 1, 30, 1, 99), p(30, 40, 3, 0, 20), p(29, 18, 6, 2, 20), p(28, 22, 4, 1, 18), p(27, 30, 2, 0, 19), p(26, 30, 2, 0, 17)], now);
  assert.equal(d.lowFree, 18, 'older than 24 h is left out');
  assert.equal(d.peakRuns, 6);
  assert.equal(d.waited, 2 * 60_000);
  assert.equal(d.freed, 4 * GB, 'every drop counts, a rise does not undo it');
  assert.equal(dayStats([], now), null);
});

test('sparklines cover the last hour and mark the limit', () => {
  const now = 3600_000 * 5;
  const h = [0, 30, 60].map((m) => ({ at: now - (60 - m) * 60_000 + 1, freePct: m }));
  const s = spark(h, 'freePct', { now, max: 100, mark: 15 });
  assert.match(s.d, /^M0\.0 \d/);
  assert.ok(s.mark > 0 && s.mark < 32);
  assert.equal(spark(h.slice(0, 1), 'freePct', { now }).d, '', 'one point draws nothing');
});

test('pause and later choices', () => {
  const evening = new Date(2026, 10, 7, 19, 30).getTime();
  assert.deepEqual(laterChoices(evening).map((c) => c[0]), ['In 1 hour', 'Tomorrow morning'], 'tonight is gone within the hour');
  const noon = new Date(2026, 10, 7, 12, 0).getTime();
  assert.deepEqual(laterChoices(noon).map((c) => c[0]), ['In 1 hour', 'Tonight', 'Tomorrow morning']);
  assert.equal(new Date(laterChoices(noon)[1][1]).getHours(), 20);
  const [hour, morning] = pauseChoices(noon);
  assert.equal(hour[1], noon + 3600_000);
  assert.equal(new Date(morning[1]).getHours(), 8);
  assert.equal(new Date(morning[1]).getDate(), 8);
});

test('the automations line says what waits and why', () => {
  const now = new Date(2026, 10, 7, 18, 0).getTime();
  assert.equal(automationsLine({ guard: {} }, 0, now), 'Running as usual');
  assert.equal(automationsLine(machineFixture(), 0, now), 'Waiting for memory: 12% free, needs 20%');
  assert.equal(automationsLine({ guard: { held: 'paused', why: 'Automations paused until 20:00', pausedUntil: now + 7200_000 } }, 0, now), 'Automations paused until 20:00');
  assert.equal(automationsLine({ guard: { held: 'memory' } }, now + 7200_000, now), 'Automations paused until 20:00', 'a pause sent from here shows before the server answers');
  assert.equal(automationsLine({ guard: { held: 'battery', why: 'Waiting for power: battery at 14%' } }, 0, now), 'Waiting for power: battery at 14%');
});
