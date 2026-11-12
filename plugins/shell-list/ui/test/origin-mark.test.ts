// A task a recipe or trigger started shows the bolt (recipe) or the trigger's mark in its row (model/row.ts markOf,
// v1 feed.js originMark).
import { expect, test } from 'vitest';
import { rowView } from '../src/model/row.ts';
import type { SessionRow } from '../src/types.ts';

const ctx = { split: false, open: false, swipes: false, here: 'This computer', agents: new Map() };
const row = (o: Partial<SessionRow>): SessionRow => ({ id: 's1', title: 'Release', agent: 'claude', state: 'done', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;

test('a recipe start shows the bolt, a trigger start its mark, a task of yours its agent_v1_origin_mark', () => {
  const recipe = rowView(row({ origin: { kind: 'recipe', name: 'Release' } }), ctx).mark;
  expect(recipe.kind === 'origin' && recipe.icon).toBe('bolt');
  const trigger = rowView(row({ origin: { kind: 'trigger', name: 'nightly' } }), ctx).mark;
  expect(trigger.kind === 'origin' && trigger.icon).toBe('replay');
  expect(rowView(row({}), ctx).mark.kind).toBe('agent');
  // a channel start (Telegram) has no mark of its own: the agent's, as v1
  expect(rowView(row({ origin: { kind: 'telegram' } }), ctx).mark.kind).toBe('agent');
});
