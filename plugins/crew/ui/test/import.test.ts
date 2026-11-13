// Import crew members (ImportCrew.tsx, v1 crew-share.js importCrew).
import { expect, test } from 'vitest';
import { joining, lockedOf, srcOf, withPassword } from '../src/import-picks.ts';

test('a_link_is_fetched_by_the_host_and_anything_else_is_the_bundles_text_and_only_ticked_members_join', () => {
  expect(srcOf('  gist:3f2a9  ')).toEqual({ url: 'gist:3f2a9' });
  expect(srcOf('https://example.com/ada.crew.json')).toEqual({ url: 'https://example.com/ada.crew.json' });
  const json = '{ "wispCrew": 1, "members": [] }';
  expect(srcOf(json)).toEqual({ text: json });
  expect(srcOf('http://insecure.example/x.json')).toEqual({ text: 'http://insecure.example/x.json' }); // https only, as v1
  // a crew shared as a link (ADR-0052): wisp Cloud, Open in wisp, a self-hosted grid's share page
  expect(srcOf('https://grid.trywisp.dev/s/k3j')).toEqual({ url: 'https://grid.trywisp.dev/s/k3j' });
  expect(srcOf('wisp://open/k3j')).toEqual({ url: 'wisp://open/k3j' });
  expect(srcOf('http://box.local:7000/s/k3j')).toEqual({ url: 'http://box.local:7000/s/k3j' });
  expect(joining({ a: { name: 'Ada', skip: false }, b: { name: 'Bea', skip: true }, c: { name: 'Cal', skip: false } })).toBe(2);
});

test('a_password_locked_link_shows_the_password_box_and_sends_the_password_with_the_link', () => {
  expect(lockedOf({ locked: 'password' })).toEqual({ wrong: false });
  expect(lockedOf({ locked: 'password', wrong: true })).toEqual({ wrong: true });
  expect(lockedOf({})).toBeUndefined(); // a review with members: no box
  expect(lockedOf({ locked: 'team' })).toBeUndefined(); // not a password: the refusal says why
  const link = srcOf('https://grid.trywisp.dev/s/k3j');
  expect(withPassword(link, '  pw  ')).toEqual({ url: 'https://grid.trywisp.dev/s/k3j', password: 'pw' });
  expect(withPassword(link, '   ')).toEqual(link);
  const file = srcOf('{ "wispCrew": 1, "members": [] }');
  expect(withPassword(file, 'pw')).toEqual(file); // a pasted file has no password
});
