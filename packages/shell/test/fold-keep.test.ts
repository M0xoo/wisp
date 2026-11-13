import { expect, test } from 'vitest';

// F-page-44 (v1 turns.js renderBody: "a new turn would push the one being read behind Show earlier: it stays")
test('a_turn_landing_while_you_read_never_folds_away_the_turn_you_read', async () => {
  const { foldedFrom } = await import('../src/frame/rows-view.ts');
  const turns = ['t1', 't2', 't3', 't4', 't5'].map((id) => ({ id }));
  // at the end: the last 3, the window slides as turns land
  expect(foldedFrom(turns, false, undefined).shown.map((t) => t.id)).toEqual(['t3', 't4', 't5']);
  // reading from t3 when t6 lands: t3 stays, the window grows
  const more = [...turns, { id: 't6' }];
  expect(foldedFrom(more, false, 't3')).toEqual({ hidden: 2, shown: more.slice(2) });
  // a `from` already inside the slid window, gone, or Show earlier open: as before
  expect(foldedFrom(more, false, 't5').shown.map((t) => t.id)).toEqual(['t4', 't5', 't6']);
  expect(foldedFrom(more, false, 'gone').hidden).toBe(3);
  expect(foldedFrom(more, true, 't3').hidden).toBe(0);
});
