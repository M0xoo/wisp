import { expect, test } from 'vitest';
import { memberRecord, type Say } from '../src/record-view.ts';

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
