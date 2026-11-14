// What waits on you in an open task (foot/model.ts): the live question and the queue, from the server's row.
import { expect, test } from 'vitest';
import { askOf, queueOf } from '../src/foot/model.ts';

test('a waiting question reads from the row with its choices; a tool approval says so; the queue keeps its order', () => {
  const row = (ask: unknown, queue: unknown[] = []) => ({ id: 's', body: { ext: { 'wisp.runtime': { ask } }, queue } });
  expect(askOf(row({ id: 'q1', question: 'Which db?', options: ['Postgres', { label: 'SQLite' }] }))).toEqual({ id: 'q1', question: 'Which db?', options: ['Postgres', 'SQLite'], approval: false });
  expect(askOf(row({ question: 'Run rm -rf build?', options: ['allow', 'always', 'deny'] }))?.approval).toBe(true);
  expect(askOf(row(null))).toBeUndefined();
  expect(askOf(undefined)).toBeUndefined();
  expect(queueOf(row(null, [{ id: 'u1', text: 'then a toggle', at: 1 }, { id: 'u2', text: 'and tests' }, { text: 'no id' }]))).toEqual([{ id: 'u1', text: 'then a toggle' }, { id: 'u2', text: 'and tests' }]);
});
