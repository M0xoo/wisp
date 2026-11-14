import { expect, test } from 'vitest';
import { hasTeam, teamRows, type Say } from '../src/team.ts';
import type { SessionRow } from '../src/types.ts';

const say: Say = (k) => k;
const job = (id: string, crew: string, kind: 'delegated' | 'mention' | 'task' | 'checkin' | 'event', from: string | undefined, more: Partial<SessionRow> = {}): SessionRow => ({
  id,
  title: `${id} title`,
  agent: 'claude',
  cwd: '',
  state: 'done',
  createdAt: Number(id.slice(1)),
  updatedAt: 0,
  crew: { id: crew, job: kind, ...(from && { from: { id: from, title: 'Lead' } }) },
  ...more,
});
const members = new Map([
  ['ada', { id: 'ada', name: 'Ada', avatar: 'x', color: 'violet' }],
  ['bo', { id: 'bo', name: 'Bo' }],
]);

test('the_leads_team_panel_lists_the_crew_jobs_it_handed_out_oldest_first_each_opening_its_job', () => {
  const jobs = [
    job('j3', 'bo', 'mention', 'lead1', { state: 'running', live: 'Reading src/' }),
    job('j1', 'ada', 'delegated', 'lead1', { preview: 'Fixed the flaky test' }),
    job('j2', 'ada', 'task', 'lead1', { preview: 'Answered' }), // asked from the lead's reply box (crew.ask)
    job('j7', 'ada', 'event', 'lead1'), // a check on the task: not work it handed out
    job('j8', 'ada', 'task', undefined), // sent from Ada's page
    job('j4', 'bo', 'delegated', 'lead2'), // another task's
    job('j5', 'ada', 'delegated', undefined),
    job('j6', 'gone', 'delegated', 'lead1', { state: 'waiting' }),
  ];
  // the task key is `peer:id`; the job's `from` is the bare id
  const rows = teamRows(jobs, 'me:lead1', (id) => members.get(id), say);
  expect(rows.map((r) => [r.id, r.handle, r.line, r.status, r.live])).toEqual([
    ['j1', '@Ada', 'Fixed the flaky test', 'wisp.crew.team.done', false],
    ['j2', '@Ada', 'Answered', 'wisp.crew.team.done', false],
    ['j3', '@Bo', 'Reading src/', 'wisp.crew.job.working', true],
    ['j6', 'wisp.crew.team.someone', 'j6 title', 'wisp.crew.job.asking', false],
  ]);
  expect(hasTeam(jobs, 'me:lead1')).toBe(true);
  expect(hasTeam(jobs, 'me:lead9')).toBe(false);
});

test('a_delegated_job_still_being_made_shows_starting_and_a_failed_one_says_so', () => {
  const rows = teamRows(
    [job('j1', 'ada', 'delegated', 'L', { pending: true, state: 'running' }), job('j2', 'ada', 'delegated', 'L', { status: 'error', state: 'review' })],
    'L',
    (id) => members.get(id),
    say,
  );
  expect(rows.map((r) => [r.status, r.tone, r.pending])).toEqual([
    ['wisp.crew.job.starting', 'accent', true],
    ['wisp.crew.team.failed', 'bad', false],
  ]);
});
