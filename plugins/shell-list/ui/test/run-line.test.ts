// The row's third line (F-task-6, v1 feed.js runLine): harness, the model's label, where it ran; the tip names the
// model ("Default model" when none was picked), the effort as "<x> thinking" and the place as "on <place>".
import { expect, test } from 'vitest';
import { runOf, type RowContext } from '../src/model/row.ts';
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
