import { expect, test } from 'vitest';
import { lastUsed, projectItems } from '../src/channel-project.ts';

const api = { id: 'api', name: 'api', path: '/w/api', color: '' };
const web = { id: 'web', name: 'web', path: '/w/web', color: '' };

test('the_default_project_picker_names_the_last_used_project_then_lists_every_project_v1_telegram_project', () => {
  const sessions = [
    { id: 'a', cwd: '/w/api', created_at: 5 },
    { id: 'b', cwd: '/w/web/src', created_at: 9 }, // inside web
    { id: 'c', cwd: '/elsewhere', created_at: 99 }, // in no project
    { id: 'd', body: { cwd: '/w/api', createdAt: 7 } }, // its fields in the body
  ];
  expect(lastUsed([api, web], sessions)?.id).toBe('web');
  expect(lastUsed([api, web], [])).toBeUndefined();
  const say = (name?: string): string => (name ? `Last used (${name})` : 'Last used');
  expect(projectItems([api, web], web, say)).toEqual([
    { value: '', label: 'Last used (web)' },
    { value: 'api', label: 'api' },
    { value: 'web', label: 'web' },
  ]);
  expect(projectItems([], undefined, say)).toEqual([{ value: '', label: 'Last used' }]);
});
