// The server's session rows, flattened the way the list reads them (docs/v2-round-7.md: the list said
// "Done" while the task said "Failed", because `status` lives in the row's `summary`).
import { expect, test } from 'vitest';
import type { SessionRow } from '../src/types.ts';
import { statusKey } from '../src/model/row.ts';
import { flatSession } from '../src/model/wire.ts';

const wire = {
  id: '01a1',
  title: 'add a greeting',
  state: 'review',
  agent: 'claude',
  updated_at: 1794261131750,
  body: { cwd: '/p', mode: 'auto', model: '' },
  summary: { status: 'blocked', preview: 'claude exited', unread: true, updatedAt: 1794261131750, queued: 0 },
} as unknown as SessionRow;

test('a server session row reads with its summary: the list shows the status the task has', () => {
  const s = flatSession(wire);
  expect(s.status).toBe('blocked');
  expect(statusKey(s)).toBe('blocked');
  expect((s as unknown as { cwd: string }).cwd).toBe('/p');
  expect(s.title).toBe('add a greeting');
  expect(flatSession(wire)).toBe(s); // the same flat row while the server row is unchanged
  const flat = { id: 'x', title: 't', state: 'done' } as unknown as SessionRow;
  expect(flatSession(flat)).toBe(flat);
});
