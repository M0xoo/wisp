// The overlap note's × (src/frame/overlap-dismiss.ts, v1 #787 overlaps.js DISMISSED): closed per task, until what it says changes.
import { expect, test } from 'vitest';
import { MAX_DISMISSED, dismiss, said, shownOverlaps } from '../src/frame/overlap-dismiss.ts';

const a = { id: 'a', files: ['src/x.ts'] };
const b = { id: 'b', files: ['src/y.ts'], conflicts: ['src/y.ts'] };

test('a closed note stays closed for that task only, whatever order the overlaps come in_v1_overlaps_dismissed', () => {
  const kept = dismiss({}, 't1', [a, b]);
  expect(shownOverlaps([a, b], kept, 't1')).toEqual([]);
  expect(shownOverlaps([b, a], kept, 't1')).toEqual([]); // ranked differently: says the same
  expect(shownOverlaps([a, b], kept, 't2')).toEqual([a, b]); // another task's note: still there
});

test('a new task, file or conflict (or one going away) brings the note back_v1_overlaps_dismissed_until_changed', () => {
  const kept = dismiss({}, 't1', [a]);
  expect(shownOverlaps([a, b], kept, 't1')).toHaveLength(2); // another task
  expect(shownOverlaps([{ ...a, files: ['src/x.ts', 'src/z.ts'] }], kept, 't1')).toHaveLength(1); // another file
  expect(shownOverlaps([{ ...a, conflicts: ['src/x.ts'] }], kept, 't1')).toHaveLength(1); // now a clash
  const both = dismiss({}, 't1', [a, b]);
  expect(shownOverlaps([a], both, 't1')).toEqual([a]); // b merged or archived: what it says changed
  // nothing overlapping: nothing to show either way
  expect(shownOverlaps([], kept, 't1')).toEqual([]);
});

test('closing one keeps the others, the most recent few hundred, oldest first to go_v1_overlaps_dismissed_prune', () => {
  const next = dismiss({ t2: said([b]) }, 't1', [a]);
  expect(Object.keys(next)).toEqual(['t2', 't1']);
  expect(next['t2']).toBe(said([b]));
  expect(dismiss(next, 't1', [a, b])['t1']).toBe(said([a, b])); // closed again on what it says now
  let all: Record<string, string> = {};
  for (let i = 0; i < MAX_DISMISSED + 3; i++) all = dismiss(all, `s${i}`, [a]);
  expect(Object.keys(all)).toHaveLength(MAX_DISMISSED);
  expect(Object.keys(all)[0]).toBe('s3');
});
