// Several projects picked (shell's project-pick.ts): the crew's list rules read the comma-joined pick.
import { expect, test } from 'vitest';
import { inProject } from '../src/rules/feed.ts';

test('a_crew_job_shows_while_its_project_is_one_of_several_picked', () => {
  const row = (projectId: string, also: string[] = []) => ({ projectId, also: also.map((a) => ({ projectId: a })) }) as never;
  expect(inProject(row('a'), 'b,a')).toBe(true);
  expect(inProject(row('c', ['b']), 'b,a')).toBe(true);
  expect(inProject(row('c'), 'b,a')).toBe(false);
  expect(inProject(row('a'), 'a')).toBe(true);
});
