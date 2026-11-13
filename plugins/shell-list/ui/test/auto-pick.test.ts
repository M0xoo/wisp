// The run Auto's best of two picked says so in its row (model/row.ts pillsOf, v1 feed.js autoPill: Pick, the
// judge's why in its tip); the other run's row and a pending row don't (F-comp-8).
import { expect, test } from 'vitest';
import { pillsOf } from '../src/model/row.ts';
import type { SessionRow } from '../src/types.ts';

const row = (o: Partial<SessionRow>): SessionRow => ({ id: 's1', title: 'Fix login', agent: 'claude', state: 'review', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;

test('the picked run of a best of two shows Pick with the why_v1_auto_pick', () => {
  const pick = pillsOf(row({ autoPick: { why: 'Run 2 kept the tests' } })).find((p) => p.id === 'autoPick');
  expect(pick?.icon).toBe('spark');
  expect(JSON.stringify(pick?.title)).toContain('Run 2 kept the tests');
  expect(pillsOf(row({})).some((p) => p.id === 'autoPick')).toBe(false);
  expect(pillsOf(row({ autoPick: { why: 'x' }, pending: true })).some((p) => p.id === 'autoPick')).toBe(false);
});
