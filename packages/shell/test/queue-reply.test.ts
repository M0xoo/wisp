// A follow-up while the task works, with Settings → Follow-ups on Queue (v1 composer.js queueing, queued.js; F-comp-24).
import { expect, test } from 'vitest';
import { followUp, queuedOps } from '../src/frame/commands.ts';

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
  expect(followUp.wire({ id: 'p:s1', text: 'two', turnId: 'p:t2', idx: 1, at: 2, queue: true })).toMatchObject({ id: 's1', queue: true });
  const reader = { peek: () => s } as never;
  const optimistic = followUp.optimistic as (b: unknown, a: unknown) => { e: string }[];
  expect(optimistic(reader, { id: 'p:s1', text: 'x', turnId: 'p:t3', idx: 1, at: 3 }).map((o) => o.e)).toEqual(['session', 'turn']);
  expect(optimistic(reader, { id: 'p:s1', text: 'x', turnId: 'p:t3', idx: 1, at: 3, queue: true }).map((o) => o.e)).toEqual(['session']);
});
