// Stop asks first (view.ts stopAsk, v1 #781).
import { expect, test } from 'vitest';
import { stopAsk } from '../src/view.ts';
import en from '../src/i18n/en.json' with { type: 'json' };

const cat = en as Record<string, string>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => {
  const n = v?.['count'];
  const key = typeof n === 'number' && cat[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : k;
  return (cat[key] ?? key).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));
};

test('stop_asks_first_and_says_what_stops_for_a_task_and_a_crew_members_jobs', () => {
  expect(stopAsk({ kind: 'task', title: 'Fix the login bug', ids: ['a'] }, t as never)).toEqual({
    title: 'Stop Fix the login bug?',
    body: 'The run ends where it is. Queued follow-ups stay, held until you send one.',
  });
  expect(stopAsk({ kind: 'crew', title: 'Ada', ids: ['a', 'b'] }, t as never).title).toBe('Stop Ada’s 2 jobs?');
  expect(stopAsk({ kind: 'crew', title: 'Ada', ids: ['a'] }, t as never).title).toBe('Stop Ada’s job?');
  // Later stops it now too, and says when it carries on
  expect(stopAsk({ kind: 'task', title: 'Refactor', ids: ['a'] }, t as never, 'tonight at 21:00')).toEqual({ title: 'Stop Refactor now?', body: 'The run ends where it is and carries on tonight at 21:00.' });
});
