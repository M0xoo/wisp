// Import crew members (ImportCrew.tsx, v1 crew-share.js importCrew).
import { expect, test } from 'vitest';
import { joining, srcOf } from '../src/import-picks.ts';

test('a_link_is_fetched_by_the_host_and_anything_else_is_the_bundles_text_and_only_ticked_members_join', () => {
  expect(srcOf('  gist:3f2a9  ')).toEqual({ url: 'gist:3f2a9' });
  expect(srcOf('https://example.com/ada.crew.json')).toEqual({ url: 'https://example.com/ada.crew.json' });
  const json = '{ "wispCrew": 1, "members": [] }';
  expect(srcOf(json)).toEqual({ text: json });
  expect(srcOf('http://insecure.example/x.json')).toEqual({ text: 'http://insecure.example/x.json' }); // https only, as v1
  expect(joining({ a: { name: 'Ada', skip: false }, b: { name: 'Bea', skip: true }, c: { name: 'Cal', skip: false } })).toBe(2);
});
