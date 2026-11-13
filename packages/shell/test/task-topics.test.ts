// ⌘K by topic (src/builtins.tsx tagsOf + palette rank, v1 F-task-21): what agents tagged a task with finds it.
import { expect, test } from 'vitest';
import { tagsOf } from '../src/palette/tasks.ts';
import { rank } from '../src/palette/match.ts';

test('a task an agent tagged is found by its topic, as #topic or the word_v1_topic_search', () => {
  const row = (title: string, tags?: unknown) => ({ id: title, title, summary: {}, body: tags === undefined ? {} : { tags } }) as never;
  expect(tagsOf(row('a', ['Auth', 'billing', 7]))).toEqual(['auth', 'billing']);
  expect(tagsOf(row('b'))).toEqual([]);
  const items = [
    { id: 'task:1', group: 'tasks', label: 'Fix the login redirect', tags: tagsOf(row('x', ['auth'])), run: () => undefined },
    { id: 'task:2', group: 'tasks', label: 'Bump the deps', run: () => undefined },
  ];
  expect(rank(items, '#auth', 0).map((r) => r.item.id)).toEqual(['task:1']);
  expect(rank(items, 'auth', 0).map((r) => r.item.id)).toEqual(['task:1']);
});
