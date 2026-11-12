// 👍 / 👎 on a turn (src/frame/commands.ts rateTurn, v1 feedback.js rateTurn): lit at once on the turn, to the task's
// own wisp with the bare ids; the line after 👎 changes nothing on the turn.
import { expect, test } from 'vitest';
import { rateTurn, ratingOf } from '../src/frame/commands.ts';

test('a thumb lights on the turn at once and goes to its wisp; taking it back clears it_v1_rate_turn', () => {
  const turn = { id: 'p:s1:t1', body: { ext: { 'wisp.runtime': { changes: [] } } } };
  const reader = { peek: () => turn } as never;
  const optimistic = rateTurn.optimistic as (b: unknown, a: unknown) => { e: string; id: string; ops: { value: Record<string, unknown> }[] }[];
  const up = optimistic(reader, { id: 'p:s1', turnKey: 'p:s1:t1', rating: 'up', at: 5 });
  expect(up[0]?.e).toBe('turn');
  expect(up[0]?.id).toBe('p:s1:t1');
  const ext = up[0]?.ops[0]?.value ?? {};
  expect(ext['wisp.runtime']).toEqual({ changes: [] }); // the other plugins' slots stay
  expect(ratingOf({ ext })).toBe('up');
  const back = optimistic(reader, { id: 'p:s1', turnKey: 'p:s1:t1', rating: null, at: 6 });
  expect(ratingOf({ ext: back[0]?.ops[0]?.value })).toBeUndefined();
  // the line after 👎: sent, nothing on the turn moves
  expect(optimistic(reader, { id: 'p:s1', turnKey: 'p:s1:t1', rating: 'down', text: 'wrong file', at: 7 })).toEqual([]);
  expect(rateTurn.wire({ id: 'p:s1', turnKey: 'p:s1:t1', rating: 'down', text: 'wrong file', at: 7 })).toEqual({
    rating: 'down',
    sessionId: 's1',
    turnId: 's1:t1',
    source: 'turn',
    text: 'wrong file',
  });
});
