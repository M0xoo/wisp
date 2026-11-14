// On touch the list keeps Mark done's own column only while some row shows Mark done (v1 feed.js `has-quick`).
import { expect, test } from 'vitest';
import { anyShowsDone, type RowContext } from '../src/model/row.ts';
import type { SessionRow } from '../src/types.ts';

const row = (o: Partial<SessionRow>): SessionRow => ({ id: 's1', title: 'Fix login', agent: 'claude', state: 'working', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;
const c = (o: Partial<RowContext> = {}): RowContext => ({ split: true, open: false, swipes: false, here: 'This computer', agents: new Map() as unknown as RowContext['agents'], ...o });

test('the_lists_done_column_exists_only_while_a_row_shows_mark_done_v1_has_quick', () => {
  const working = { key: 'a', s: row({}) };
  const review = { key: 'b', s: row({ state: 'review' }) };
  expect(anyShowsDone([working], () => c())).toBe(false);
  expect(anyShowsDone([working, review], () => c())).toBe(true);
  // archived, a subagent, or the phone app's swipes: no Mark done, so no column
  expect(anyShowsDone([{ key: 'b', s: row({ state: 'review', archived: true } as Partial<SessionRow>) }], () => c())).toBe(false);
  expect(anyShowsDone([{ key: 'b', s: row({ state: 'review', parentId: 'p' } as Partial<SessionRow>) }], () => c())).toBe(false);
  expect(anyShowsDone([review], () => c({ swipes: true }))).toBe(false);
  // the open task on a phone (no split) shows none
  expect(anyShowsDone([review], () => c({ split: false, open: true }))).toBe(false);
});
