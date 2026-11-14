// Share… from a task's row menu (src/share/params.ts, v1 share.js shareable).
import { expect, test } from 'vitest';
import { parseShareParams, shareable } from '../src/share/params.ts';

test('a task of yours on this computer can be shared; the view takes its entity key_v1_shareable', () => {
  const mine = { id: 'local:s1', agent: 'claude' };
  expect(shareable(mine)).toBe(true);
  for (const odd of [{ agent: 'wisp' }, { parentId: 's0' }, { kind: 'reminder' }, { pending: true }, { delegated: true }, { machine: { id: 'box' } }])
    expect(shareable({ ...mine, ...odd })).toBe(false);
  expect(parseShareParams({ session: 'local:s1' })).toEqual({ session: 'local:s1' });
  expect(() => parseShareParams({ session: 's1' })).toThrow();
});
