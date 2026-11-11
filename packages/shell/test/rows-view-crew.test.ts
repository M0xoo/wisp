import { expect, test } from 'vitest';
import { crewOf } from '../src/frame/rows-view.ts';

test('a_picked_crew_members_list_holds_only_the_tasks_that_are_their_jobs', () => {
  expect(crewOf({ body: { ext: { 'wisp.crew': { id: 'ada', job: 'task' } } } })).toBe('ada');
  expect(crewOf({ body: { ext: { 'wisp.router': {} } } })).toBeUndefined();
  expect(crewOf({})).toBeUndefined();
});
