// Done asks about the worktree: which tasks this client marked done, what the setting does with the
// folders, and what the dialog says (src/done.ts, src/view.ts).
import { describe, expect, it } from 'vitest';
import type { EntityKey, PendingInfo, PeerId } from '@wisp/client';
import { heading, holdsWork, initiallyTicked, losesOf, newlyDone, outcome, planDone, removal, removeButton, stateOf, withSizes } from '../src/done.ts';
import { t } from '../src/i18n.ts';
import type { DoneFolder } from '../src/types.ts';
import { doneTitle, parseDone } from '../src/view.ts';

const peer = 'home' as PeerId;
const key = (id: string): EntityKey => `home:${id}` as EntityKey;
const done = (mid: string, id: string, value = 'done'): PendingInfo => ({ mid, peer, ops: [{ e: 'session', id: key(id), op: 'patch', ops: [{ op: 'replace', path: '/state', value }] }] });
const folder = (path: string, over: Partial<DoneFolder> = {}): DoneFolder => ({ path, task: 'lead', title: 'Fix', own: true, branch: `wisp/${path}`, size: null, only: 0, uncommitted: 0, unpushed: 0, pr: null, kept: false, ...over });

describe('which tasks this client just marked done', () => {
  it('a new Done patch asks once; a reopen, another kind or a command seen before does not', () => {
    const seen = new Set<string>(['old']);
    expect(newlyDone([done('old', 'a'), done('m1', 'b'), done('m2', 'c', 'review'), { mid: 'm3', peer, ops: [{ e: 'worktrees.item', id: key('d'), op: 'patch', ops: [{ op: 'replace', path: '/state', value: 'done' }] }] }], seen)).toEqual([key('b')]);
    expect(newlyDone([done('m1', 'b')], seen), 'the same command again (its ack) asks nothing').toEqual([]);
    // Mark every run done: one command per run, one question per run
    expect(newlyDone([done('r1', 'x'), done('r2', 'y')], seen)).toEqual([key('x'), key('y')]);
  });
});

describe('what the setting does', () => {
  const clean = folder('/a');
  const dirty = folder('/b', { only: 2, uncommitted: 2 });
  const unknown = folder('/c', { only: null, uncommitted: null });

  it('ask shows every row, remove takes the clean ones and asks about the rest, keep pins them all', () => {
    expect(planDone('ask', [clean, dirty])).toEqual({ keep: [], remove: [], ask: [clean, dirty], only: false });
    expect(planDone('remove', [clean, dirty, unknown])).toEqual({ keep: [], remove: ['/a'], ask: [dirty, unknown], only: true });
    expect(planDone('remove', [clean])).toEqual({ keep: [], remove: ['/a'], ask: [], only: false });
    expect(planDone('keep', [clean, dirty])).toEqual({ keep: ['/a', '/b'], remove: [], ask: [], only: false });
    expect(planDone('ask', [])).toEqual({ keep: [], remove: [], ask: [], only: false });
  });

  it('a folder git can’t read holds work; clean rows start ticked', () => {
    expect([clean, dirty, unknown].map(holdsWork)).toEqual([false, true, true]);
    expect(initiallyTicked([clean, dirty, unknown])).toEqual(['/a']);
  });
});

describe('what a row says', () => {
  const said = (f: DoneFolder): string => {
    const s = stateOf(f);
    return t(s.key, s.vars);
  };
  it('the first state that applies', () => {
    expect(said(folder('/a', { only: null }))).toBe('Can’t read it');
    expect(said(folder('/a', { only: 3, uncommitted: 3 }))).toBe('3 uncommitted files');
    expect(said(folder('/a', { only: 1, uncommitted: 0 }))).toBe('Commits off its branch');
    expect(said(folder('/a', { pr: { number: 9, url: '', state: 'OPEN' } }))).toBe('PR #9 open');
    expect(said(folder('/a', { pr: { number: 9, url: '', state: 'MERGED' } }))).toBe('PR #9 merged');
    expect(said(folder('/a', { unpushed: 1 }))).toBe('1 commit not pushed');
    expect(said(folder('/a'))).toBe('Clean');
    expect(stateOf(folder('/a', { only: 1 })).warn).toBe(true);
  });
  it('what ticking one holding work loses', () => {
    const l = (f: DoneFolder): string | undefined => {
      const s = losesOf(f);
      return s && t(s.key, s.vars);
    };
    expect(l(folder('/a'))).toBeUndefined();
    expect(l(folder('/a', { only: 1, uncommitted: 1 }))).toBe('1 uncommitted file will be lost');
    expect(l(folder('/a', { only: 1, uncommitted: 0 }))).toBe('Its commits off the branch will be lost');
    expect(l(folder('/a', { only: null }))).toBe('Git can’t read it: what’s in it may be lost');
  });
});

describe('the dialog', () => {
  const clean = folder('/a');
  const dirty = folder('/b', { only: 2, uncommitted: 2, own: false, task: 'job', title: 'Job' });

  it('its title and line, from the params and then the rows', () => {
    expect(doneTitle(parseDone({ key: 'home:t1', n: 1 }))).toBe('Remove its worktree?');
    expect(doneTitle(parseDone({ key: 'home:t1', n: 3 }))).toBe('Remove its 3 worktrees?');
    expect(doneTitle(parseDone({ key: 'home:t1', n: 2, only: true }))).toBe('These worktrees hold work');
    expect(() => parseDone({ n: 1 })).toThrow();
    const h = heading([clean, dirty], false);
    expect(t(h.hint.key, h.hint.vars)).toContain('The one holding work goes only if you tick it.');
    expect(heading([clean], false).hint.key).toBe('worktrees.folders.hint');
  });

  it('Remove counts the ticked rows, turns red on one holding work, and forces only those', () => {
    const b = (ticked: string[]) => {
      const r = removeButton([clean, dirty], ticked);
      return { label: t(r.label.key, r.label.vars), danger: r.danger, disabled: r.disabled };
    };
    expect(b([])).toEqual({ label: 'Remove', danger: false, disabled: true });
    expect(b(['/a'])).toEqual({ label: 'Remove', danger: false, disabled: false });
    expect(b(['/a', '/b'])).toEqual({ label: 'Remove 2', danger: true, disabled: false });
    expect(removal([clean, dirty], ['/b', '/a', '/elsewhere'])).toEqual({ remove: ['/a', '/b'], force: ['/b'] });
  });

  it('the toast says what went and how much, or what was kept and why', () => {
    const sized = withSizes([clean, dirty], [{ ...clean, size: 2048 }]);
    expect(sized.map((f) => f.size)).toEqual([2048, null]);
    const ok = outcome({ removed: ['/a'], kept: [], failed: [] }, sized);
    expect(ok?.tone).toBe('success');
    expect(ok && t(ok.said.key, { ...ok.said.vars, size: '2 KB' })).toBe('Removed 1 folder · 2 KB');
    const bad = outcome({ removed: [], kept: [], failed: [{ path: '/b', error: 'It’s in use.' }] }, sized);
    expect(bad && t(bad.said.key, bad.said.vars)).toBe('Kept “Job”: It’s in use.');
    expect(outcome({ removed: [], kept: ['/a'], failed: [] }, sized)).toBeUndefined();
  });
});
