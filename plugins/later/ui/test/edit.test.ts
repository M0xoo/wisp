// F-auto-7 (v1 0.49.0): a waiting follow-up's text or time is changed before it goes. LaterFoot's pen edits the
// text in place and its clock is Change time…; both run `later.edit`, whose patch shows the change at once, also on a
// server row, where what's scheduled lives in `body.ext["wisp.later"].later` (wisp.later's mirror).
import { expect, test } from 'vitest';
import type { EntityReader } from '@wisp/client';
import { cancelFollowUp, editFollowUp, editedText, laterOf } from '../src/commands.ts';
import type { SessionRow } from '../src/types.ts';

const a = { id: 'l1', at: 2_000, text: 'check the deploy', by: 'user' as const };
const b = { id: 'l2', at: 3_000, text: 'look at CI', by: 'agent' as const };

/** A reader holding one session row. */
const reader = (row: object): EntityReader => ({ peek: () => row }) as unknown as EntityReader;
const serverRow = { id: 't1', title: 'Ship it', state: 'review', body: { ext: { 'wisp.later': { later: [a, b] } } } };
type Op = { e: string; op: string; ops: { op: string; path: string; value?: unknown }[] };
const patched = (ops: unknown): unknown => (ops as Op[])[0]?.ops.find((o) => o.path === '/later')?.value;
const opt = (def: unknown, row: object, args: object): unknown =>
  patched((def as { optimistic: (r: EntityReader, a: object) => unknown }).optimistic(reader(row), args));

test('an_edit_in_place_sends_the_new_text_and_nothing_when_left_emptied_or_unchanged', () => {
  expect(editedText('check the deploy', 'check the deploy on staging ')).toBe('check the deploy on staging');
  expect(editedText('check the deploy', undefined)).toBeUndefined(); // Escape
  expect(editedText('check the deploy', '   ')).toBeUndefined(); // emptied: the follow-up stays as it was
  expect(editedText('check the deploy', ' check the deploy')).toBeUndefined();
});

test('the_new_text_or_time_shows_at_once_on_a_server_row_whose_list_is_in_ext', () => {
  expect(laterOf(serverRow as unknown as SessionRow)).toEqual([a, b]);
  expect(opt(editFollowUp, serverRow, { sessionId: 'p:t1', item: 'l1', text: 'check staging' })).toEqual([{ ...a, text: 'check staging' }, b]);
  // a later time re-sorts it
  expect(opt(editFollowUp, serverRow, { sessionId: 'p:t1', item: 'l1', at: 9_000 })).toEqual([b, { ...a, at: 9_000 }]);
  // Send now and Cancel take it off at once, the last one too (an empty list, so the mirror doesn't show it again)
  expect(opt(editFollowUp, serverRow, { sessionId: 'p:t1', item: 'l1', now: true })).toEqual([b]);
  const one = { ...serverRow, body: { ext: { 'wisp.later': { later: [a] } } } };
  expect(opt(cancelFollowUp, one, { sessionId: 'p:t1', item: 'l1' })).toEqual([]);
  // a flat list (v1's row, an earlier patch) emptied is removed, as before
  const flat = { id: 't1', later: [a] };
  const ops = (cancelFollowUp as unknown as { optimistic: (r: EntityReader, a: object) => Op[] }).optimistic(reader(flat), { sessionId: 'p:t1', item: 'l1' });
  expect(ops[0]?.ops).toEqual([{ op: 'remove', path: '/later' }]);
});
