import { expect, test } from 'vitest';
import { spiritCode } from '@wisp/ui/pure';
import { crewTint, glowOf } from '../src/frame/crew-tint.ts';

test('a_picked_crew_member_tints_the_list_with_their_glow_unless_the_setting_or_their_tint_says_none', () => {
  const spirit = spiritCode({ shape: 'blob', color: 'teal', eyes: 'dots', mouth: 'smile', extra: 'none' });
  const m = { id: 'm1', name: 'Reviewer', avatar: spirit, color: 'rose' };
  // the spirit's colour wins over the one it was given (the face and the list never disagree)
  expect(glowOf(m)).toBe('teal');
  expect(glowOf({ id: 'm2', name: 'Bot', avatar: '🤖', color: 'amber' })).toBe('amber');
  expect(crewTint(m, null)).toBe('teal');
  expect(crewTint(m, true)).toBe('teal');
  expect(crewTint({ ...m, bg: 'sky' }, true)).toBe('sky');
  // nothing picked, the setting off, or their tint none
  expect(crewTint(undefined, true)).toBeUndefined();
  expect(crewTint(m, false)).toBeUndefined();
  expect(crewTint({ ...m, bg: 'none' }, true)).toBeUndefined();
});
