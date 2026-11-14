// The task header's status pill (frame/rows-view.ts statusOf).
import { describe, expect, it, test } from 'vitest';
import { nextNeedsYou, statusOf } from '../src/frame/rows-view.ts';
import type { SessionRow } from '../src/rows.ts';

const t = (key: string): string => key;
const row = (state: string, status: string): SessionRow => ({ id: 'x', state, summary: { status } }) as unknown as SessionRow;

test('a task waiting on a question says Waiting, whatever its last turn said (a stalled goal asks after a done turn)', () => {
  expect(statusOf(row('waiting', 'done'), t)).toEqual({ label: 'shell.status.waiting', tone: 'warn' });
  expect(statusOf(row('review', 'done'), t).label).toBe('shell.status.finished');
  expect(statusOf(row('running', 'done'), t).tone).toBe('live');
});

describe('turn figures', () => {
  it('a_turns_time_and_its_lines_read_as_v1_shows_them_and_older_turns_fold', async () => {
    const { duration, changeFigures, folded } = await import('../src/frame/rows-view.ts');
    expect([duration(369), duration(12_400), duration(184_000), duration(3_720_000)]).toEqual(['369ms', '12s', '3m 4s', '1h 2m']);
    const f = changeFigures([
      { file: 'a.ts', edits: [{ before: 'x\ny', after: 'x\ny\nz' }] },
      { file: 'a.ts', edits: [{ before: '', after: 'new\n' }] },
      { file: 'b.ts', edits: [] },
    ]);
    expect(f).toEqual({ files: 2, plus: 4, minus: 2 });
    expect(folded([1, 2, 3, 4], false)).toEqual({ hidden: 0, shown: [1, 2, 3, 4] });
    expect(folded([1, 2, 3, 4, 5, 6], false)).toEqual({ hidden: 3, shown: [4, 5, 6] });
    expect(folded([1, 2, 3, 4, 5, 6], true).hidden).toBe(0);
  });
});

test('leaving_a_task_opens_the_next_that_needs_you_else_new_task', () => {
  const row = (id: string, state: string, at: number, more: Record<string, unknown> = {}) =>
    ({ id, title: id, state, agent: 'claude', archived: false, unread: false, created_at: 0, updated_at: at, summary: {}, ...more }) as never;
  const rows = [
    row('local:a', 'review', 10),
    row('local:b', 'review', 30),
    row('local:c', 'running', 50),
    row('local:d', 'review', 40, { archived: true }),
    row('local:e', 'waiting', 20, { parent_id: 'local:b' }),
    row('local:f', 'done', 60),
  ];
  expect(nextNeedsYou(rows, 'local:b')).toBe('local:a'); // the newest left in Needs you, not the one just done
  expect(nextNeedsYou(rows, 'b')).toBe('local:a'); // a bare id is the same task
  expect(nextNeedsYou(rows, 'local:x')).toBe('local:b');
  expect(nextNeedsYou([row('local:a', 'review', 1)], 'local:a')).toBeUndefined(); // nothing else: New task
});
