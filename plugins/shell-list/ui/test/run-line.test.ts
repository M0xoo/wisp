// The row's third line (F-task-6, v1 feed.js runLine): harness, the model's label, where it ran; the tip names the
// model ("Default model" when none was picked), the effort as "<x> thinking" and the place as "on <place>".
import { expect, test } from 'vitest';
import { pillsOf, runOf, type RowContext } from '../src/model/row.ts';
import type { SessionRow } from '../src/types.ts';

const row = (o: Partial<SessionRow>): SessionRow => ({ id: 's1', title: 'Fix login', agent: 'claude', state: 'review', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;
const agents = new Map([['claude', { id: 'claude', name: 'Claude Code', models: [{ id: 'opus', label: 'Opus 4.7' }] }]]) as unknown as RowContext['agents'];
const c: RowContext = { split: true, open: false, swipes: false, here: 'This computer', agents };

test('a_rows_run_line_says_harness_model_label_and_place_with_v1s_tip', () => {
  const r = runOf(row({ model: 'opus', effort: 'high' } as Partial<SessionRow>), c);
  expect(r?.agentName).toBe('Claude Code');
  expect(r?.model).toBe('Opus 4.7');
  expect(r?.where).toBe('This computer');
  expect(r?.title).toEqual({ key: 'shell-list.run.tip-effort', vars: { agent: 'Claude Code', model: 'Opus 4.7', effort: 'High', where: 'This computer' } });
  const bare = runOf(row({ machine: { id: 'm1', name: 'box-1' } } as Partial<SessionRow>), c);
  expect(bare?.model).toBeUndefined();
  expect(bare?.where).toBe('box-1');
  expect(bare?.remote).toBe(true);
  expect(bare?.title.key).toBe('shell-list.run.tip-default');
  // no run line for wisp's own rows and reminders
  expect(runOf(row({ agent: 'wisp' }), c)).toBeUndefined();
  expect(runOf(row({ kind: 'reminder' } as Partial<SessionRow>), c)).toBeUndefined();
});

test('a_crashed_limited_or_refused_rows_pill_says_which_v1_halt', async () => {
  // F-task-14: the summary's `halt` (runtime core summarize) beats the agent's "Blocked"; a finished verdict keeps its own word
  const { flatSession } = await import('../src/model/wire.ts');
  const label = (o: Record<string, unknown>): unknown => pillsOf(flatSession({ id: 's1', state: 'review', summary: { status: 'blocked', ...o } } as never)).find((p) => p.id === 'status')?.label;
  expect(label({ halt: 'limit' })).toEqual({ key: 'shell-list.status.limit' });
  expect(label({ halt: 'refused' })).toEqual({ key: 'shell-list.status.refused' });
  expect(label({ halt: 'failed' })).toEqual({ key: 'shell-list.status.failed' });
  expect(label({})).toEqual({ key: 'shell-list.status.blocked' });
  expect(label({ status: 'done', halt: 'failed' })).toEqual({ key: 'shell-list.status.done' });
});

test('a_capped_rows_pill_names_its_cap_and_an_uncapped_row_has_none', async () => {
  // F-chan-10: runtime's list field `capped`, flattened from the summary like every other
  const { flatSession } = await import('../src/model/wire.ts');
  const cap = (o: Record<string, unknown>): unknown => pillsOf(flatSession({ id: 's1', state: 'review', summary: { status: 'done', ...o } } as never)).find((p) => p.id === 'capped');
  expect(cap({ capped: 'edits' })).toEqual({ id: 'capped', label: { key: 'shell-list.pill.capped-edits' }, tone: 'warn', icon: 'lock', variant: 'outline', title: { key: 'shell-list.pill.capped-edits-tip' } });
  expect(cap({ capped: 'plan' })).toMatchObject({ label: { key: 'shell-list.pill.capped-plan' } });
  expect(cap({})).toBeUndefined();
  expect(cap({ capped: 'auto' })).toBeUndefined();
});

test('a_trial_runs_line_says_its_one_change_after_the_model_v1_try_two_ways', async () => {
  // F-comp-31: runtime's `variant`, flattened from the summary; both rows of a trial share a harness, this tells them apart
  const { flatSession } = await import('../src/model/wire.ts');
  const { variantOf } = await import('../src/model/row.ts');
  const b = flatSession({ id: 's2', state: 'review', agent: 'claude', summary: { status: 'done', variant: { subagentModel: 'haiku', skills: 'off' } } } as never);
  expect(variantOf(b)).toEqual([
    { key: 'shell-list.run.subagents', vars: { name: 'Haiku' } },
    { key: 'shell-list.run.skills-off' },
  ]);
  expect(runOf(b, c)?.variant).toHaveLength(2);
  expect(variantOf(row({ variant: { subagentModel: '' } } as Partial<SessionRow>))).toEqual([{ key: 'shell-list.run.subagents-task' }]);
  expect(runOf(row({}), c)?.variant).toBeUndefined();
});
