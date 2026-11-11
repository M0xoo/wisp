import { expect, test } from 'vitest';
import { summary } from '../src/panes/Automations.tsx';

test('automations_lines_say_none_yet_or_name_what_there_is_as_v1_did', () => {
  expect(summary([], 'save a prompt you run often')).toBe('None yet · save a prompt you run often');
  expect(summary(['Triage', 'Deps'], 'x')).toBe('Triage, Deps');
  expect(summary(['a', 'b', 'c', 'd', 'e'], 'x')).toBe('a, b, c and 2 more');
});
