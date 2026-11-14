import { expect, test } from 'vitest';
import { crewLimits, memberLimits, memberRecord, type MemberLimit, type Say } from '../src/record-view.ts';

const say: Say = (k, v) => (v ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : k);

test('a_members_track_record_leads_with_its_tokens_then_where_they_went_and_its_biggest_jobs', () => {
  const s = {
    id: 'm1',
    jobs: 14,
    done: 12,
    failed: 1,
    quiet: 3,
    tokens: 84_000,
    byKind: { task: { runs: 4, tokens: 24_000, quiet: 0 }, checkin: { runs: 60, tokens: 60_000, quiet: 3 }, mention: { runs: 0, tokens: 0, quiet: 0 } },
    top: [{ id: 's1', title: 'Fix CI', job: 'task', tokens: 21_000 }, { id: 's2', title: '', job: 'checkin', tokens: 1_000 }],
    days: 30,
  };
  const r = memberRecord(s, 30, say);
  expect(r.head).toBe('wisp.crew.record.head(tokens=84k,day=3k)');
  // the repeating work (check-ins) is the bulk: first, as runs a day × tokens each; a kind with no runs isn't listed
  expect(r.kinds.map((k) => [k.key, k.pct])).toEqual([['checkin', 71], ['task', 29]]);
  expect(r.kinds[0]?.line).toBe('wisp.crew.record.kindRepeating(n=2,each=1k,quiet=5)');
  expect(r.kinds[1]?.line).toBe('wisp.crew.record.kindAsked(count=4,each=6k)');
  expect(r.top).toEqual([{ id: 's1', title: 'Fix CI', tokens: '21k', pct: 25 }, { id: 's2', title: 'wisp.crew.record.untitled', tokens: '1k', pct: 1 }]);
  expect(r.outcome).toBe('wisp.crew.record.finishedOf(n=12,of=14) · wisp.crew.record.failedN(n=1) · wisp.crew.record.quietN(n=3)');
  expect(r.empty).toBe(false);
});

test('a_member_with_no_jobs_in_the_range_says_so_and_an_old_peer_without_tokens_reads_as_zero', () => {
  expect(memberRecord(undefined, 7, say).empty).toBe(true);
  const r = memberRecord({ id: 'm1', jobs: 2, done: 2, failed: 0, quiet: 0 }, 7, say);
  expect(r.head).toBe('wisp.crew.record.head(tokens=0,day=0)');
  expect(r.kinds).toEqual([]);
  expect(r.outcome).toBe('wisp.crew.record.finishedOf(n=2,of=2)');
});

const lim = (window: string, used: number, mine: number, crew: number, over: Partial<MemberLimit> = {}): MemberLimit => ({
  agent: 'claude',
  account: 'default',
  window,
  label: window === 'five_hour' ? '5-hour' : 'Weekly',
  used,
  resetsAt: 9,
  since: 1,
  mine,
  crew,
  traced: 0.5,
  ...over,
});
const when = (at: number): string => `t${at}`;

test('what_ate_my_limits_leads_a_members_record_with_the_fullest_two_windows_its_jobs_took_part_of', () => {
  const s = { id: 'm1', jobs: 1, done: 1, failed: 0, quiet: 0, limits: [lim('five_hour', 0.3, 0.1, 0.1), lim('seven_day', 0.95, 0.2, 0.4), lim('x', 0.1, 0.05, 0.05, { since: null })] };
  const r = memberLimits(s, 'Ada', say, when);
  expect(r.map((x) => [x.key, x.pct, x.tone])).toEqual([
    ['claude@default/seven_day', '95%', 'warn'],
    ['claude@default/five_hour', '30%', undefined],
  ]);
  expect([r[0]?.label, r[0]?.agent, r[0]?.account]).toEqual(['Weekly', 'claude', '']);
  expect(r[0]?.line).toBe('wisp.crew.record.tookWithCrew(since=wisp.crew.record.since(at=t1),name=Ada,mine=20%,crew=40%) · wisp.crew.record.resets(at=t9)');
  // alone on the crew: only its part
  expect(r[1]?.line.startsWith('wisp.crew.record.took(')).toBe(true);
  expect(memberLimits({ id: 'm1', jobs: 0, done: 0, failed: 0, quiet: 0 }, 'Ada', say, when)).toEqual([]);
});

test('the_crews_limits_name_its_biggest_members_and_what_your_own_tasks_took', () => {
  const work = lim('seven_day', 0.6, 0, 0.35, { account: 'work' });
  const list = [
    { id: 'a', jobs: 1, done: 1, failed: 0, quiet: 0, limits: [{ ...work, mine: 0.25 }] },
    { id: 'b', jobs: 1, done: 1, failed: 0, quiet: 0, limits: [{ ...work, mine: 0.1 }] },
    { id: 'c', jobs: 1, done: 1, failed: 0, quiet: 0 },
  ];
  const r = crewLimits(list, (id) => id.toUpperCase(), say, when);
  expect(r).toHaveLength(1);
  expect([r[0]?.label, r[0]?.account]).toEqual(['Weekly', 'work']);
  expect(r[0]?.line).toBe('wisp.crew.record.crewTook(since=wisp.crew.record.since(at=t1),crew=35%,top=A 25%, B 10%,yours=15%) · wisp.crew.record.resets(at=t9)');
});
