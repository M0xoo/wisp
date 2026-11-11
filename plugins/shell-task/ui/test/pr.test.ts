import { describe, expect, it } from 'vitest';
import { checkGroups, dur, gist, prFiles, talk, verdict, type PrPanel } from '../src/side/pr.ts';

const pr = (o: Partial<PrPanel> = {}): PrPanel => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', base: 'main', ...o });

describe('the PR pane', () => {
  it('the_pr_pane_says_where_the_pr_stands_in_one_line_with_its_one_next_step', () => {
    expect(verdict(pr({ state: 'MERGED' }))).toMatchObject({ tone: 'merged', vars: { base: 'main' } });
    expect(verdict(pr({ state: 'CLOSED' })).tone).toBe('closed');
    expect(verdict(pr({ conflict: true }), { canFix: true })).toMatchObject({ tone: 'fail', act: 'fix' });
    expect(verdict(pr({ conflict: true })).act).toBeUndefined();
    expect(verdict(pr({ conflict: true }), { fixing: true, canFix: true })).toMatchObject({ tone: 'pending', key: 'shell-task.pr.fixing' });
    // failing checks outrank a change request, which outranks running checks
    expect(verdict(pr({ checks: { fail: 2, pending: 1 }, reviewers: [{ author: 'lena', state: 'CHANGES_REQUESTED' }] }))).toMatchObject({ key: 'shell-task.pr.failing', vars: { count: 2 } });
    expect(verdict(pr({ checks: { pending: 1 }, reviewers: [{ author: 'lena', state: 'CHANGES_REQUESTED' }] }))).toMatchObject({ key: 'shell-task.pr.changes', vars: { name: 'lena' } });
    expect(verdict(pr({ checks: { pending: 3 } }))).toMatchObject({ tone: 'pending', act: 'merge' });
    expect(verdict(pr({ draft: true })).tone).toBe('draft');
    expect(verdict(pr({ review: 'REVIEW_REQUIRED' })).key).toBe('shell-task.pr.needsReview');
    expect(verdict(pr())).toMatchObject({ tone: 'pass', act: 'merge', primary: true });

    // checks: the bad first; the passed fold unless nothing is wrong
    const g = checkGroups([{ name: 'a', state: 'pass' }, { name: 'b', state: 'fail' }, { name: 'c', state: 'skip' }, { name: 'd', state: 'pending' }]);
    expect(g.bad.map((c) => c.name)).toEqual(['b', 'd']);
    expect([g.passed, g.skipped, g.okOpen]).toEqual([1, 1, false]);
    expect(checkGroups([{ name: 'a', state: 'pass' }]).okOpen).toBe(true);
    expect([dur(0), dur(12_000), dur(72_000), dur(3_720_000)]).toEqual(['', '12s', '1m 12s', '1h 2m']);

    // the conversation: empty notes go, bots and outdated threads fold
    const c = talk(pr({ notes: [{ author: 'a', body: ' ' }, { author: 'b', body: 'hi' }, { author: 'bot', bot: true, body: 'ci' }], threads: [{ path: 'x', notes: [{ author: 'a', body: 'n' }] }, { path: 'y', outdated: true, notes: [{ author: 'a', body: 'o' }] }, { path: 'z', notes: [] }] }));
    expect([c.people.length, c.bots.length, c.live.length, c.outdated.length]).toEqual([1, 1, 1, 1]);
    expect(gist('<!-- x -->Hello ![img](u) <b>world</b>\n\n\n\nok')).toBe('Hello  world\n\nok');
    expect(gist('a'.repeat(10), 4)).toBe('aaaa…');

    // files: by path, 8 then the count GitHub gave
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${9 - i}`, additions: 1, deletions: 0 }));
    const f = prFiles(pr({ files, changedFiles: 12 }), false);
    expect([f.shown[0]?.path, f.shown.length, f.more]).toEqual(['f0', 8, 4]);
    expect(prFiles(pr({ files }), true).more).toBe(0);
  });
});
