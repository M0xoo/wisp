// Each task keeps its place (src/frame/place.ts, v1 split.js keepPlace/backToPlace): by the turn at the top, or the end.
import { expect, test } from 'vitest';
import { keep, placeOf, scrollFor, MAX_PLACES } from '../src/frame/place.ts';

const turns = [
  { id: 't1', top: 0 },
  { id: 't2', top: 800 },
  { id: 't3', top: 1600 },
];

test('a task reopens where it was read, held by its turn, so a new turn above it shifts nothing_v1_keep_place', () => {
  const p = placeOf({ scrollTop: 950, clientHeight: 600, scrollHeight: 3000 }, turns);
  expect(p).toEqual({ end: false, turn: 't2', dy: 150, top: 950 });
  // later, older turns folded away (t2 now at 300): the same line of t2 is at the top
  expect(
    scrollFor(p!, { clientHeight: 600, scrollHeight: 2500 }, [
      { id: 't2', top: 300 },
      { id: 't3', top: 1100 },
    ]),
  ).toBe(450);
  // at the end: back to the end, new turns and all
  const end = placeOf({ scrollTop: 2400, clientHeight: 600, scrollHeight: 3000 }, turns);
  expect(end?.end).toBe(true);
  expect(scrollFor(end!, { clientHeight: 600, scrollHeight: 3600 }, turns)).toBe(3000);
  // at the top: nothing kept; its turn gone: the raw offset
  expect(placeOf({ scrollTop: 0, clientHeight: 600, scrollHeight: 3000 }, turns)).toBeUndefined();
  expect(scrollFor({ end: false, turn: 'gone', dy: 10, top: 700 }, { clientHeight: 600, scrollHeight: 3000 }, turns)).toBe(700);
});

test('the most recent hundred tasks keep theirs, the oldest go first_v1_max_places', () => {
  let all = {};
  for (let i = 0; i < MAX_PLACES + 5; i++) all = keep(all, `s${i}`, { end: false, dy: 0, top: i + 1 });
  expect(Object.keys(all)).toHaveLength(MAX_PLACES);
  expect(Object.keys(all)[0]).toBe('s5');
  expect(Object.keys(keep(all, 's7', undefined))).not.toContain('s7');
  expect(Object.keys(keep(all, 's5', { end: true, dy: 0, top: 1 })).at(-1)).toBe('s5'); // touched: newest
});
