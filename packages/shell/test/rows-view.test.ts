// The task header's status pill (frame/rows-view.ts statusOf).
import { expect, test } from 'vitest';
import { statusOf } from '../src/frame/rows-view.ts';
import type { SessionRow } from '../src/rows.ts';

const t = (key: string): string => key;
const row = (state: string, status: string): SessionRow => ({ id: 'x', state, summary: { status } }) as unknown as SessionRow;

test('a task waiting on a question says Waiting, whatever its last turn said (a stalled goal asks after a done turn)', () => {
  expect(statusOf(row('waiting', 'done'), t)).toEqual({ label: 'shell.status.waiting', tone: 'warn' });
  expect(statusOf(row('review', 'done'), t).label).toBe('shell.status.finished');
  expect(statusOf(row('running', 'done'), t).tone).toBe('live');
});
