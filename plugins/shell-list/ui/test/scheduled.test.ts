// F-auto-8 (v1 0.56.0): a task whose agent scheduled a check-in moves from Needs you to Scheduled once its turn ends.
// wisp.later mirrors what's scheduled into the task's `body.ext["wisp.later"].later` (runtime.setExt); the list
// reads it as v1's `later`.
import { expect, test } from 'vitest';
import type { SessionRow } from '../src/types.ts';
import { flatSession } from '../src/model/wire.ts';
import { isScheduled, needsYou, sections } from '../src/model/sections.ts';

const row = (id: string, state: string, later?: unknown[]): SessionRow =>
  flatSession({
    id,
    title: id,
    state,
    agent: 'claude',
    unread: true,
    created_at: 1,
    updated_at: 2,
    body: { cwd: '/p', ...(later && { ext: { 'wisp.later': { later } } }) },
    summary: { status: state, preview: '' },
  } as unknown as SessionRow);

const checkIn = { id: 'l1', at: 1_800_000_600_000, text: 'see if CI passed', by: 'agent' };

test('an_agents_check_in_moves_its_finished_task_from_needs_you_to_scheduled', () => {
  const rows = [row('waits', 'review', [checkIn]), row('plain', 'review'), row('busy', 'running', [checkIn])];
  expect(rows[0]?.later?.[0]?.by).toBe('agent');
  expect(isScheduled(rows[0] as SessionRow)).toBe(true);
  expect(needsYou(rows[0] as SessionRow)).toBe(false);
  const keyed = rows.map((s) => ({ key: `p:${s.id}`, s }));
  const out = sections(keyed as never, { project: 'all' });
  const ids = (k: keyof typeof out): string[] => out[k].map((e) => (e as { s?: SessionRow }).s?.id ?? '').filter(Boolean);
  expect(ids('scheduled')).toEqual(['waits']);
  expect(ids('needs')).toEqual(['plain']);
  expect(ids('working')).toEqual(['busy']);
});

test('a_reminder_alone_or_an_empty_mirror_leaves_the_task_where_it_was', () => {
  const remind = row('r', 'review', [{ ...checkIn, remind: true }]);
  expect(isScheduled(remind)).toBe(false);
  const cleared = row('c', 'review', []);
  expect(cleared.later).toBeUndefined();
  expect(needsYou(cleared)).toBe(true);
});

test('the_soonest_follow_up_leads_the_row_whatever_order_they_were_set_in', () => {
  const s = row('two', 'review', [{ ...checkIn, id: 'late', at: 9_000, by: 'user' }, { ...checkIn, id: 'soon', at: 2_000 }]);
  expect(s.later?.map((l) => l.id)).toEqual(['soon', 'late']);
});
