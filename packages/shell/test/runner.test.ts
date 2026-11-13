import { expect, test } from 'vitest';
import { accountChoices, accountFor, effortsFor, harnessesFor, modelsFor, runnerWords, type AccountOffer, type AgentOffer, runPick, fullest, usedPct } from '../src/frame/runner.ts';

const AGENTS: AgentOffer[] = [
  { id: 'codex', name: 'Codex', available: true, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], efforts: ['low', 'high'] },
  { id: 'cursor', name: 'Cursor', available: false, models: [], efforts: [] },
  { id: 'claude', name: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku', label: 'Haiku 5.5' }], efforts: ['low', 'high'] },
];

test('the_harness_model_picker_searches_every_harnesses_models_and_offers_the_picks_thinking_levels', () => {
  // set up ones first; a model's name finds its harness
  expect(harnessesFor(AGENTS, '').map((a) => a.id)).toEqual(['codex', 'claude', 'cursor']);
  expect(harnessesFor(AGENTS, 'opus').map((a) => a.id)).toEqual(['claude']);
  // the Default first; a query narrows, the harness's own name keeps them all
  expect(modelsFor(AGENTS, 'claude', '').map((m) => m.id)).toEqual(['', 'opus', 'haiku']);
  expect(modelsFor(AGENTS, 'claude', 'hai').map((m) => m.id)).toEqual(['haiku']);
  expect(modelsFor(AGENTS, 'claude', 'claude').length).toBe(3);
  expect(modelsFor(AGENTS, 'nope', '')).toEqual([]);
  // a model's own levels, else the harness's
  expect(effortsFor(AGENTS, { agent: 'claude', model: 'opus', effort: '' })).toEqual(['low', 'medium', 'high', 'max']);
  expect(effortsFor(AGENTS, { agent: 'claude', model: 'haiku', effort: '' })).toEqual(['low', 'high']);
  expect(runnerWords(AGENTS, { agent: 'claude', model: 'opus', effort: 'high' }, (id) => (id === 'claude' ? 'Claude Code' : id))).toBe('Claude Code · Opus 5.5 · high');
});

test('the_reply_boxs_harness_model_pick_goes_with_the_next_follow_up_and_none_keeps_the_tasks_own', () => {
  expect(runPick(undefined)).toBeUndefined();
  expect(runPick({ agent: 'codex', model: '', effort: '' })).toEqual({ agent: 'codex' });
  expect(runPick({ agent: 'claude', model: 'opus', effort: 'high' })).toEqual({ agent: 'claude', model: 'opus', effort: 'high' });
});

// F-comp-38: before you pick, each harness says how much of its plan is gone: its fullest window over its accounts
// (v1 runner-picker.js fullest/usageNote), whole percents rounded down; none known, no line.
test('the harness picker shows each harness fullest plan window_v1_picker_usage', () => {
  const w = fullest([
    { windows: [{ label: '5h', used: 0.42 }, { label: 'Week', used: 0.31 }] },
    { windows: [{ label: '5h', used: 0.879 }] },
  ]);
  expect(w?.label).toBe('5h');
  expect(w && usedPct(w)).toBe(87);
  expect(fullest([])).toBeUndefined();
  expect(fullest([{ windows: [] }])).toBeUndefined();
});

// F-comp-41: a harness that's installed but signed out sits with the set-up ones, so it can be picked to sign in
// right there (v1 runner-picker.js signedOut / paintSignIn).
test('a signed out harness sits with the set up ones so it can be picked to sign in_v1_picker_sign_in', () => {
  const list: AgentOffer[] = [
    { id: 'cursor', name: 'Cursor', available: false, models: [], efforts: [] },
    { id: 'codex', name: 'Codex', available: false, signedIn: false, models: [], efforts: [] },
    { id: 'claude', name: 'Claude Code', available: true, models: [], efforts: [] },
  ];
  expect(harnessesFor(list, '').map((a) => a.id)).toEqual(['codex', 'claude', 'cursor']);
});

const WORDS = { auto: 'Auto', autoHint: 'saved', limit: 'at limit', out: 'signed out' };

test('a_second_account_shows_in_the_picker_and_the_task_starts_on_the_one_picked', () => {
  const one: AccountOffer[] = [{ id: 'default', label: 'Main', default: true, state: 'ready' }];
  // one account: no choice (v1 accountsAt: two or more)
  expect(accountChoices(one, WORDS)).toEqual([]);
  expect(accountFor(one, 'default')).toBe('');
  const two: AccountOffer[] = [
    { id: 'default', label: 'Main', email: 'me@home.dev', plan: 'Max', default: true, state: 'ready' },
    { id: 'w1', label: 'Work', state: 'limit', until: 9 },
    { id: 'p2', label: 'Spare', state: 'signedOut' },
  ];
  const rows = accountChoices(two, WORDS);
  // Auto first, then your order; a signed-out one can't be picked, one at its limit can and says so
  expect(rows.map((r) => r.value)).toEqual(['', 'default', 'w1', 'p2']);
  expect(rows[1]).toEqual({ value: 'default', label: 'Main', hint: 'me@home.dev · Max' });
  expect(rows[2]).toEqual({ value: 'w1', label: 'Work', hint: 'at limit' });
  expect(rows[3]?.disabled).toBe(true);
  expect(accountFor(two, 'w1')).toBe('w1');
  expect(accountFor(two, 'p2')).toBe('');
  expect(accountFor(two, 'gone')).toBe('');
  // the bar says which account
  expect(runnerWords(AGENTS, { agent: 'codex', model: '', effort: '', account: 'w1', accountLabel: 'Work' }, (id) => id)).toBe('codex · Work');
});
