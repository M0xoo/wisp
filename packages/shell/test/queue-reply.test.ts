// A follow-up while the task works, with Settings → Follow-ups on Queue (v1 composer.js queueing, queued.js; F-comp-24).
import { expect, test } from 'vitest';
import { followUp, queuedOps } from '../src/frame/commands.ts';
import { field, optimisticOf, patchOps, patchValue, peekReader, wireOf } from './command.ts';

test('a queued reply goes in the queue at once, not as a new turn, and the peer is told to queue_v1_queue_reply', () => {
  const s = { id: 'p:s1', state: 'running', body: { queue: [{ id: 'p:t1', text: 'one', at: 1 }] } } as never;
  const ops = queuedOps(s, { id: 'p:s1', text: 'two', turnId: 'p:t2', at: 2 });
  expect(ops).toEqual([
    {
      e: 'session',
      id: 'p:s1',
      op: 'patch',
      ops: [
        {
          op: 'add',
          path: '/body/queue',
          value: [
            { id: 'p:t1', text: 'one', at: 1 },
            { id: 'p:t2', text: 'two', at: 2 },
          ],
        },
        { op: 'replace', path: '/summary/queued', value: 2 },
      ],
    },
  ]);
  // what goes to the peer says queue; without it the follow-up steers the run (and shows as its turn)
  expect(wireOf(followUp)({ id: 'p:s1', text: 'two', turnId: 'p:t2', idx: 1, at: 2, queue: true })).toMatchObject({ id: 's1', queue: true });
  const reader = peekReader(s);
  const optimistic = optimisticOf(followUp);
  expect(optimistic(reader, { id: 'p:s1', text: 'x', turnId: 'p:t3', idx: 1, at: 3 }).map((o) => o.e)).toEqual(['session', 'turn']);
  expect(optimistic(reader, { id: 'p:s1', text: 'x', turnId: 'p:t3', idx: 1, at: 3, queue: true }).map((o) => o.e)).toEqual(['session']);
});

test('/btw asks on the side and shows answering at once; × drops it_v1_btw', async () => {
  const { btw, btwDrop, btwOf, btwQuestion } = await import('../src/frame/commands.ts');
  expect(btwQuestion('/btw did you update the docs?')).toBe('did you update the docs?');
  expect(btwQuestion('/BTW  why?')).toBe('why?');
  expect(btwQuestion('btw not a command')).toBeUndefined();
  expect(btwQuestion('/btwx no')).toBeUndefined();
  const row = { id: 'p:s1', body: { ext: { 'wisp.runtime': { titleAuto: true } } } };
  const asked = optimisticOf(btw)(peekReader(row), {
    id: 'p:s1',
    question: 'why?',
    tmp: 'b1',
    at: 5,
  });
  const slot = field(patchValue(asked), 'wisp.runtime');
  expect(slot).toEqual({ titleAuto: true, btw: [{ id: 'b1', question: 'why?', at: 5, pending: true }] });
  expect(wireOf(btw)({ id: 'p:s1', question: 'why?', tmp: 'b1', at: 5 })).toEqual({ id: 's1', question: 'why?' });
  const withOne = { id: 'p:s1', body: { ext: { 'wisp.runtime': { btw: [{ id: 'b1', question: 'q', at: 1 }] } } } } as never;
  expect(btwOf(withOne)).toHaveLength(1);
  const dropped = optimisticOf(btwDrop)(peekReader(withOne), { id: 'p:s1', btwId: 'b1' });
  expect(field(patchValue(dropped), 'wisp.runtime', 'btw')).toEqual([]);
});

test('a new question to an archived task brings it back to the list at once_v1_unarchive_on_reply', () => {
  const reader = peekReader({ id: 'p:s1', state: 'review', archived: true });
  const ops = patchOps(optimisticOf(followUp)(reader, { id: 'p:s1', text: 'one more thing', turnId: 'p:t9', idx: 3, at: 9 }));
  expect(ops).toContainEqual({ op: 'replace', path: '/archived', value: false });
  expect(ops).toContainEqual({ op: 'replace', path: '/state', value: 'running' });
});
