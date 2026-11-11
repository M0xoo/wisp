import { expect, test } from 'vitest';
import { crewOf } from '../src/frame/rows-view.ts';

test('a_picked_crew_members_list_holds_only_the_tasks_that_are_their_jobs', () => {
  expect(crewOf({ body: { ext: { 'wisp.crew': { id: 'ada', job: 'task' } } } })).toBe('ada');
  expect(crewOf({ body: { ext: { 'wisp.router': {} } } })).toBeUndefined();
  expect(crewOf({})).toBeUndefined();
});

test('the_rail_reads_a_crew_members_face_from_the_rows_body', async () => {
  const { flatRow } = await import('../src/frame/rows-view.ts');
  expect(flatRow<{ id: string; avatar?: string }>({ id: 'm1', name: 'Ada', body: { avatar: 'blob.teal', color: 'teal' } })).toMatchObject({ id: 'm1', name: 'Ada', avatar: 'blob.teal', color: 'teal' });
  expect(flatRow<{ id: string }>({ id: 'x' })).toEqual({ id: 'x' });
});

test('back_from_a_subagents_run_on_a_phone_opens_its_lead_v1_773', async () => {
  const { backOf } = await import('../src/frame/rows-view.ts');
  expect(backOf('peer1:sub9', { parent_id: 'lead1' })).toBe('peer1:lead1');
  expect(backOf('peer1:t1', { parent_id: null })).toBeUndefined();
  expect(backOf('peer1:t1', undefined)).toBeUndefined();
});
