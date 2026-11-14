// Save to My Stuff from a reply (frame/keep-ops.ts, v1 features/stuff.js toggleSave): what goes to the task's computer
// and the card My Stuff shows at once.
import { entityKey, type PeerId } from '@wisp/client';
import { expect, test } from 'vitest';
import { keepKey, keepSave, shownOf, type SaveArgs } from '../src/frame/keep-ops.ts';
import { optimisticOf, peekReader, wireOf } from './command.ts';

const peer = 'mac' as PeerId;
const args = (o: Partial<SaveArgs>): SaveArgs => ({
  peer,
  temp: entityKey(peer, 'tmp-1'),
  from: { session: 's1', turn: 't1', key: keepKey('mac:s1', 't1', 'media:shot.png') },
  shown: shownOf('tmp-1', { kind: 'image', path: 'shot.png' }, 'k', 5),
  ...o,
});

test('the_same_thing_in_the_same_turn_is_one_key_so_saving_it_twice_finds_the_one_kept', () => {
  expect(keepKey('mac:s1', 't1', 'media:shot.png')).toBe('mac:s1|t1|media:shot.png');
  expect(keepKey('mac:s1', 't2', 'media:shot.png')).not.toBe(keepKey('mac:s1', 't1', 'media:shot.png'));
});

test('a_replys_picture_is_saved_on_the_tasks_computer_by_the_tasks_own_path_as_you', () => {
  const a = args({ file: 'shot.png', title: 'Login' });
  expect(keepSave.owner(a)).toBe(peer);
  expect(wireOf(keepSave)(a)).toEqual({ file: 'shot.png', title: 'Login', from: a.from, by: 'you' });
  // a snippet: its text and language, no file
  expect(wireOf(keepSave)(args({ text: 'x', lang: 'ts', name: 'a.ts' }))).toEqual({ text: 'x', lang: 'ts', name: 'a.ts', from: a.from, by: 'you' });
});

test('the_card_shows_in_my_stuff_at_once_as_a_pending_placeholder', () => {
  const ops = optimisticOf(keepSave)(peekReader(undefined), args({ file: 'shot.png' }));
  expect(ops).toEqual([{ e: 'stuff.item', id: 'mac:tmp-1', op: 'upsert', v: { id: 'tmp-1', kind: 'image', name: 'shot.png', title: 'shot.png', size: 0, at: 5, by: 'you', from: { key: 'k' }, pending: true } }]);
  const doc = shownOf('t', { kind: 'doc', text: 'héllo', name: 'n.md', title: 'N' }, 'k', 1);
  expect(doc).toMatchObject({ size: 6, excerpt: 'héllo', name: 'n.md', title: 'N' });
});
