import { describe, expect, it } from 'vitest';
import { flatRow, noticeFor } from '../src/notify.ts';

const t = (k: string, v?: Readonly<Record<string, string | number>>): string => `${k}${v ? JSON.stringify(v) : ''}`;
const row = (state: string, summary: Record<string, unknown> = {}) => ({ id: 's1', title: 'Fix login', state, archived: false, summary: { preview: 'done it', question: '', approval: false, ...summary } });

describe('notify', () => {
  it('a_task_that_finishes_or_asks_tells_you_once_from_the_stores_row_shape', () => {
    const running = flatRow(row('running'));
    const done = flatRow(row('review'));
    const asking = flatRow(row('review', { question: 'Which branch?' }));
    expect(running?.question).toBeUndefined();
    const fin = noticeFor(running, done!, { siblings: [], t });
    expect(fin?.head).toContain('shell-home.notify.ready');
    expect(fin?.body).toBe('done it');
    const ask = noticeFor(done, asking!, { siblings: [], t });
    expect(ask?.asks).toBe(true);
    expect(ask?.body).toBe('Which branch?');
    expect(noticeFor(asking, asking!, { siblings: [], t })).toBeNull();
    expect(noticeFor(done, done!, { siblings: [], t })).toBeNull();
  });
});
