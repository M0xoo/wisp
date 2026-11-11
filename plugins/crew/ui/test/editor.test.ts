import { expect, test } from 'vitest';
import { addWake, draftOf, patchOf, problemOf, wakeLabel } from '../src/editor.ts';
import type { Member } from '../src/types.ts';

const say = (k: string, v?: Readonly<Record<string, string | number>>): string => (k === 'wisp.crew.editor.wake.after' ? `After ${v?.['name']} reports` : k);

test('the_crew_editor_saves_only_what_changed_and_its_wakes_as_trigger_specs_for_this_member', () => {
  const m = { name: 'Ada', role: 'reviews PRs', brief: '', cron: '', parallel: 1, agent: 'claude', mode: 'auto', cwd: '/w/web', wakes: [{ on: 'pr.opened' }] } as unknown as Member;
  const d = draftOf(m);
  expect(d.wakes).toEqual([{ on: 'pr.opened' }]);
  // a new one: on call, one job at once, Full auto, no wakes
  expect(draftOf(undefined)).toMatchObject({ name: '', cron: '', parallel: 1, mode: 'auto', wakes: [] });
  // only the changes go, trimmed; a hand-off after Bob reports
  const wakes = addWake(d.wakes, 'crew.reported', 'Bob');
  expect(patchOf({ ...d, role: ' reviews every PR ', wakes }, d)).toEqual({ role: 'reviews every PR', wakes: [{ on: 'pr.opened' }, { on: 'crew.reported', match: { member: 'Bob' } }] });
  expect(patchOf(d, d)).toEqual({});
  expect(addWake(wakes, 'crew.reported', 'Bob')).toHaveLength(2);
  expect(wakeLabel({ on: 'crew.reported', match: { member: 'Bob' } }, (o) => o, say)).toBe('After Bob reports');
  expect(wakeLabel({ on: 'pr.opened' }, () => 'PR opened', say)).toBe('PR opened');
  // the name: needed, its shape, not another member's
  expect(problemOf({ ...d, name: ' ' }, [])).toBe('wisp.crew.editor.need.name');
  expect(problemOf({ ...d, name: '!x' }, [])).toBe('wisp.crew.editor.bad.name');
  expect(problemOf({ ...d, name: 'bob' }, ['Bob'])).toBe('wisp.crew.editor.taken');
  expect(problemOf(d, ['Bob'])).toBeUndefined();
});

test('a_crew_member_row_reads_its_fields_from_its_body_as_the_crew_host_writes_it', async () => {
  const { memberOf } = await import('../src/data.ts');
  const m = memberOf({ id: 'm1', name: 'Ada', updated_at: 5, body: { id: 'm1', name: 'Ada', role: 'reviews', avatar: 'blob.teal', paused: true, wakes: [{ on: 'pr.opened' }] } });
  expect(m).toMatchObject({ id: 'm1', name: 'Ada', role: 'reviews', avatar: 'blob.teal', paused: true, wakes: [{ on: 'pr.opened' }] });
  // a row already flat (dev data, an optimistic upsert) is its own
  expect(memberOf({ id: 'm2', name: 'Bob', role: 'x' })).toMatchObject({ role: 'x' });
});
