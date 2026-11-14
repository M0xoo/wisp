// Try it two ways (src/frame/trial.ts; v1 #650 runner-picker.js What's different, compare-metrics.js variantWords and
// differsWords; F-comp-31, ADR-0056): the copy's menu, the trial the launch sends, the words rows and Compare show,
// the run order, and the trial and Keep commands' wire and optimistic patch.
import { expect, test } from 'vitest';
import { differs, differsWords, pickVary, runOrder, trialVary, varyMenu, variantWords } from '../src/frame/trial.ts';
import { trial, trialKeep } from '../src/frame/commands.ts';
import { optimisticOf, peekReader, wireOf } from './command.ts';
import { SHELL_STRINGS } from '../src/i18n/en.ts';

const t = (key: string, p: Readonly<Record<string, string | number>> = {}): string =>
  String((SHELL_STRINGS as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ''));
const CAN = ['subagentModel', 'skills'];

test('the copy of the lead offers Subagents and Skills, checked as the run would really go_v1_whats_different', () => {
  const m = varyMenu(t, CAN, undefined, 'haiku');
  const groups = m.filter((e) => e.kind === 'group');
  expect(groups.map((g) => g.label)).toEqual(['Subagents', 'Skills']);
  // no pick yet: the setting (Haiku) is what run B's subagents would use, and Skills are on
  expect(groups[0]?.items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Haiku']);
  expect(groups[1]?.items.filter((i) => i.checked).map((i) => i.label)).toEqual(['On']);
  // a harness that runs neither: nothing offered
  expect(varyMenu(t, [], undefined, '')).toEqual([]);
  expect(varyMenu(t, ['skills'], undefined, '').map((e) => (e.kind === 'group' ? e.id : ''))).toEqual(['vary-skills']);
});

test('a pick changes run B, a harness pick is not a change, and Skills on clears it_v1_choose_variant', () => {
  const v = pickVary(undefined, 'vary:sub:sonnet');
  expect(v).toEqual({ subagentModel: 'sonnet' });
  expect(pickVary(v, 'vary:skills:off')).toEqual({ subagentModel: 'sonnet', skills: 'off' });
  expect(pickVary({ skills: 'off' }, 'vary:skills:on')).toEqual({});
  expect(pickVary(v, 'codex')).toBeUndefined();
  expect(pickVary(undefined, 'vary:sub:')).toEqual({ subagentModel: '' });
});

test('the launch is a trial only for one copy of the lead that really differs_v1_try_two_ways', () => {
  expect(trialVary('claude', ['claude'], { skills: 'off' }, '')).toEqual({ skills: 'off' });
  expect(trialVary('claude', ['claude'], { subagentModel: 'haiku' }, '')).toEqual({ subagentModel: 'haiku' });
  // the same as run A (the setting already puts subagents on Haiku): not a trial, never two identical paid runs
  expect(differs({ subagentModel: 'haiku' }, 'haiku')).toBe(false);
  expect(trialVary('claude', ['claude'], { subagentModel: 'haiku' }, 'haiku')).toBeUndefined();
  expect(trialVary('claude', ['claude'], { subagentModel: '' }, 'haiku')).toEqual({ subagentModel: '' });
  // another harness, or a third run: a plain compare
  expect(trialVary('claude', ['codex'], { skills: 'off' }, '')).toBeUndefined();
  expect(trialVary('claude', ['claude', 'codex'], { skills: 'off' }, '')).toBeUndefined();
  expect(trialVary('claude', ['claude'], undefined, '')).toBeUndefined();
  expect(trialVary('claude', ['claude'], {}, '')).toBeUndefined();
});

test('a run says its change, and Compare says what differed against run A_v1_differs_words', () => {
  expect(variantWords(t, { subagentModel: 'haiku', skills: 'off' })).toEqual(['Subagents on Haiku', 'Skills off']);
  // the task's own model, picked: said (as the row says it)
  expect(variantWords(t, { subagentModel: '' })).toEqual(['Subagents on task’s model']);
  expect(variantWords(t, undefined)).toEqual([]);
  expect(differsWords(t, [{ key: 'subagentModel', values: ['', 'haiku'] }], 'opus')).toBe('Subagents: opus → Haiku');
  expect(differsWords(t, [{ key: 'subagentModel', values: ['', 'haiku'] }])).toBe('Subagents: Task’s model → Haiku');
  expect(differsWords(t, [{ key: 'skills', values: ['on', 'off'] }])).toBe('Skills: on → off');
  expect(differsWords(t, [])).toBe('Same setup on both runs');
});

test('a trial is shown A then B whatever order its rows arrive in_v1_trial_letters', () => {
  const row = (id: string, created_at: number, run?: number) => ({ id, created_at, summary: run === undefined ? {} : { trial: { group: 'g', run, differs: [] } } });
  expect(runOrder([row('b', 5, 1), row('a', 5, 0)]).map((r) => r.id)).toEqual(['a', 'b']);
  // a plain compare: by age, as before
  expect(runOrder([row('y', 9), row('x', 3)]).map((r) => r.id)).toEqual(['x', 'y']);
});

test('the trial shows both rows at once, run B with its change; Keep archives the other at once_v1_trial_kept', () => {
  const args = {
    peer: 'p',
    ids: ['p:a', 'p:b'] as const,
    group: 'g-1',
    vary: { skills: 'off' },
    task: { prompt: 'fix it\nmore', agent: 'claude', mode: 'auto', at: 1, cwd: '/repo', projectId: 'pr1' },
  };
  expect(wireOf(trial)(args)).toEqual({ ids: ['p:a', 'p:b'], task: { ...args.task, worktree: true }, vary: { skills: 'off' } });
  const ops = optimisticOf(trial)(peekReader(undefined), args) as readonly { id: string; op: string; v: { title: string; summary: Record<string, unknown> } }[];
  expect(ops.map((o) => [o.id, o.op])).toEqual([
    ['p:a', 'upsert'],
    ['p:b', 'upsert'],
  ]);
  expect(ops[0]?.v.title).toBe('fix it');
  expect(ops[0]?.v.summary['groupId']).toBe('g-1');
  expect(ops[0]?.v.summary['variant']).toBeUndefined();
  // no differs yet: Compare says nothing rather than "Same setup" until the peer's link arrives
  expect(ops[1]?.v.summary['trial']).toEqual({ group: 'g-1', run: 1 });
  expect(ops[1]?.v.summary['variant']).toEqual({ skills: 'off' });
  expect(wireOf(trialKeep)({ id: 'p:b', others: ['p:a'] })).toEqual({ id: 'b' });
  const keep = optimisticOf(trialKeep)(peekReader(undefined), { id: 'p:b', others: ['p:a'] }) as readonly { id: string; ops: { path: string; value: unknown }[] }[];
  expect(keep.map((o) => [o.id, o.ops[0]?.value])).toEqual([
    ['p:b', false],
    ['p:a', true],
  ]);
});
