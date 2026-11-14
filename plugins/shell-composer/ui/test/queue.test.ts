// The queue's model (src/model/queue.ts, v1 queued.js): what each row says, and the moves the list makes.
import { expect, test } from 'vitest';
import { edit, remove, reorder, tagOf } from '../src/model/queue.ts';
import type { QueueItem, Row } from '../src/types.ts';

const q: readonly Row<QueueItem>[] = [
  { id: 'a', text: 'one', at: 1 },
  { id: 'b', text: 'two', at: 2 },
  { id: 'c', text: 'three', at: 3 },
];

test('the first waits for the run, or after a Stop for you; the rest are numbered_v1_queue_held_after_stop', () => {
  expect(tagOf(0, false, 'Claude Code')).toEqual({ key: 'shell-composer.queue.next', vars: { name: 'Claude Code' } });
  expect(tagOf(0, true, 'Claude Code')).toEqual({ key: 'shell-composer.queue.held', vars: {} });
  expect(tagOf(2, true, 'Claude Code')).toEqual({ key: 'shell-composer.queue.nth', vars: { n: 3 } });
});

test('reorder, cancel and edit move or change only what was asked_v1_queue_moves', () => {
  expect(reorder(q, ['b', 'a', 'c']).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  // an id the client doesn't know keeps its place at the end, nothing is lost
  expect(reorder(q, ['c']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  expect(remove(q, 'b').map((x) => x.id)).toEqual(['a', 'c']);
  expect(edit(q, 'a', '  first  ')[0]?.text).toBe('first');
  expect(edit(q, 'a', '   ')).toEqual(q); // emptying isn't cancelling
});
