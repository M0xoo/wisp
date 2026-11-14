import { expect, test } from 'vitest';
import { ordered, shareLine, sharesOf } from '../src/shares.ts';
import { t } from '../src/i18n.ts';

const say = t as never;

test('my_shares_lists_what_i_shared_with_its_access_counts_and_version_live_ones_first', () => {
  const raw = [
    { id: 'a', url: 'https://g/s/a', kind: 'task', title: 'Fix login', version: 2, access: { kind: 'anyone' }, views: 3, imports: 1, updatedAt: 10 },
    { id: 'b', url: 'https://g/s/b', kind: 'setup', title: 'Reviewer', access: { kind: 'people', people: ['ada', 'bob'] }, views: 1, imports: 0, revoked: true, updatedAt: 30 },
    { id: 'c', url: 'https://g/s/c', kind: 'app', title: 'Todo', access: { kind: 'password' }, expiresAt: 5, updatedAt: 20 },
    { nope: true },
  ];
  const list = sharesOf(raw);
  expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  expect(sharesOf({ shares: raw }).length).toBe(3);
  expect(sharesOf(null)).toEqual([]);
  expect(ordered(list, 100).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  expect(shareLine(list[0]!, 100, say)).toBe('Task · Anyone with the link · 3 views · 1 import · v2');
  expect(shareLine(list[1]!, 100, say)).toBe('Stopped: the link no longer opens');
  expect(shareLine(list[2]!, 100, say)).toBe('Expired');
  expect(shareLine({ ...list[1]!, revoked: false }, 100, say)).toBe('Setup · 2 people · 1 view · 0 imports');
});
