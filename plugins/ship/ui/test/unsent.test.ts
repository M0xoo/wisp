// Ship and Merge say what's not sent yet (src/unsent.ts, v1 F-page-11), read through the shell's prompt sources.
import { expect, test } from 'vitest';
import { withUnsent } from '../src/unsent.ts';
import { unsentLine } from '../src/model/merge.ts';

const t = (key: string, p: Readonly<Record<string, string | number>> = {}): string =>
  key === 'wisp.ship.warn.unsent' ? `You have ${p['count']} review comment${p['count'] === 1 ? '' : 's'} in Changes you haven’t sent.` : key;

test('comments waiting in a source count into the row Ship and Merge read; none says nothing_v1_unsent_comments', () => {
  const counts: Record<string, number> = { 'p:a': 2 };
  const count = (task: string): number => counts[task] ?? 0;
  expect(withUnsent({ id: 'p:a' }, count)?.unsentComments).toBe(2);
  expect(withUnsent({ id: 'p:b' }, count)?.unsentComments).toBe(0);
  expect(withUnsent(undefined, count)).toBeUndefined();
  expect(unsentLine(t, withUnsent({ id: 'p:a' }, count)?.unsentComments)).toBe('You have 2 review comments in Changes you haven’t sent.');
  expect(unsentLine(t, withUnsent({ id: 'p:b' }, count)?.unsentComments)).toBe('');
});
