import { expect, test } from 'vitest';
import { isSpirit, makerOptions, parseSpirit } from '@wisp/ui/pure';

test('the_spirit_maker_offers_each_part_swapped_into_the_members_spirit_and_marks_the_one_it_has', () => {
  const avatar = 'flame.teal.visor.smile.antenna';
  const eyes = makerOptions(avatar, 'Ada', 'eyes');
  expect(eyes.map((o) => o.value)).toEqual(['dots', 'happy', 'wide', 'sleepy', 'visor', 'wink', 'spark']);
  // only the eyes change: picking "wide" keeps the body, glow, mouth and extra
  expect(eyes.find((o) => o.value === 'wide')?.code).toBe('flame.teal.wide.smile.antenna');
  expect(eyes.filter((o) => o.on).map((o) => o.value)).toEqual(['visor']);
  expect(makerOptions(avatar, 'Ada', 'color').every((o) => isSpirit(o.code))).toBe(true);
});

test('an_emoji_avatar_gets_choices_rolled_from_the_name_with_none_marked_picked', () => {
  const shapes = makerOptions('🦊', 'Ada', 'shape');
  expect(shapes.some((o) => o.on)).toBe(false);
  // every choice is a whole spirit, seeded by the name: picking one replaces the emoji
  const seeded = parseSpirit('', 'Ada');
  expect(shapes[0]?.code).toBe(`flame.${seeded.color}.${seeded.eyes}.${seeded.mouth}.${seeded.extra}`);
  // no name yet: still seeded (as 'wisp'), never an empty code
  expect(makerOptions('', '', 'mouth').every((o) => isSpirit(o.code))).toBe(true);
});
