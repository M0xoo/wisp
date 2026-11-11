import { expect, test } from 'vitest';
import { jobOf } from '../src/jobs.ts';
import { facts, pillOf, quietLabel } from '../src/page.ts';
import { t } from '../src/i18n.ts';
import type { Member } from '../src/types.ts';

const say = t as never;

test('a_members_page_reads_its_jobs_from_the_peers_task_rows_and_says_how_it_works', () => {
  // runtime's row, the crew's note in body.ext
  const row = {
    id: 's1',
    title: 'Review #12',
    state: 'review',
    agent: 'claude',
    archived: false,
    unread: true,
    created_at: 10,
    updated_at: 20,
    summary: { status: 'done', preview: 'Two nits', live: '', cwd: '/w/web' },
    body: { ext: { 'wisp.crew': { id: 'ada', job: 'task', prompt: 'review #12' } } },
  };
  const j = jobOf(row);
  expect(j).toMatchObject({ id: 's1', state: 'review', createdAt: 10, updatedAt: 20, cwd: '/w/web', preview: 'Two nits', unread: true, crew: { id: 'ada', job: 'task', prompt: 'review #12' } });
  // a task nobody's crew works on
  expect(jobOf({ id: 's2', body: { ext: {} } })).toBeUndefined();
  expect(jobOf({ id: 's3' })).toBeUndefined();
  const m = { cron: '', on: [], parallel: 2, cwd: '/w/web', machine: '', agent: 'claude', mode: 'auto', team: [] } as unknown as Member;
  expect(facts(m, { t: say, harness: () => ({ name: 'Claude Code' }), place: (x) => x }).map((f) => f.text)).toEqual([
    'Only when asked',
    '2 jobs at once',
    'web · This computer',
    'Claude Code · Full auto',
    'No delegates',
  ]);
  expect(pillOf(j!, say)).toEqual({ label: 'Done', tone: 'good' });
  expect(pillOf({ ...j!, state: 'waiting' }, say)?.label).toBe('Asking you');
  expect(
    quietLabel(
      [
        { ...j!, crew: { id: 'ada', job: 'checkin' } },
        { ...j!, crew: { id: 'ada', job: 'checkin' } },
      ],
      say,
    ),
  ).toBe('2 check-ins · nothing new');
});
