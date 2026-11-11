import { expect, test } from 'vitest';
import { teamPrefill, teamRows } from '../src/frame/pickers.ts';

test('new_task_prefills_its_team_from_settings_and_sends_each_delegate_as_settings_names_it', () => {
  const setting = [{ name: 'reviewer', agent: 'codex', model: 'gpt-5', use: 'review' }, { bad: true }, { name: 'x', agent: '' }];
  expect([...teamPrefill(setting)]).toEqual(['codex']);
  expect([...teamPrefill(null)]).toEqual([]);
  const name = (a: string): string => ({ grok: 'Grok', codex: 'Codex' })[a] ?? a;
  expect(teamRows(new Set(['codex', 'grok']), setting, name)).toEqual([{ name: 'reviewer', agent: 'codex', model: 'gpt-5', use: 'review' }, { name: 'Grok', agent: 'grok' }]);
});
