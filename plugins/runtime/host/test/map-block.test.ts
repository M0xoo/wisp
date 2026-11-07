// The `map` block (v1 test/map-block.test.js): places on a Google map (src/blocks/map-spec.ts), its
// protocol entry and its text stand-in. v1's last test (map's kit parts, icon and comment label)
// tests the page: it moves with the UI port.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLACES, embedUrl, mapPlaces, mapZoom, openUrl, routeUrl } from '../src/blocks/map-spec.ts';
import { SYSTEM_PROMPT } from '../src/blocks/prompt.ts';
import { blocksToMarkdown } from '../src/blocks/render.ts';
import { BUILTIN_BLOCKS } from '../src/blocks/check.ts';

test('places come from objects, plain strings, addresses or one address on the block', () => {
  assert.deepEqual(mapPlaces({ places: [{ name: ' Blue  Bottle ', address: '66 Mint St, San Francisco', note: 'Opens 7am' }] }), [
    { name: 'Blue Bottle', address: '66 Mint St, San Francisco', note: 'Opens 7am', q: '66 Mint St, San Francisco' },
  ]);
  assert.deepEqual(mapPlaces({ places: ['1 Main St', 'Rue du Lac 3, Lausanne'] }).map((p) => p.q), ['1 Main St', 'Rue du Lac 3, Lausanne']);
  assert.deepEqual(mapPlaces({ addresses: ['10 Downing St, London'] }).map((p) => p.q), ['10 Downing St, London']);
  const one = mapPlaces({ title: 'The office', address: 'Avenue de Rhodanie 2, Lausanne', name: 'HQ' });
  assert.deepEqual(one, [{ name: 'HQ', address: 'Avenue de Rhodanie 2, Lausanne', note: '', q: 'Avenue de Rhodanie 2, Lausanne' }], "the block's title isn't a place name");
  // A name alone is still something to search for.
  assert.equal(mapPlaces({ places: [{ name: 'Eiffel Tower' }] })[0]?.q, 'Eiffel Tower');
});

test('coordinates win over the address, in any common shape; bad ones are ignored', () => {
  const q = (b: Record<string, unknown>): string | undefined => mapPlaces(b)[0]?.q;
  assert.equal(q({ places: [{ address: 'x', lat: 46.5, lng: 6.6 }] }), '46.5,6.6');
  assert.equal(q({ places: [{ latitude: '46.5', longitude: '6.6' }] }), '46.5,6.6');
  assert.equal(q({ places: [{ coords: [46.5, 6.6] }] }), '46.5,6.6');
  assert.equal(q({ places: [{ coords: '46.5, 6.6' }] }), '46.5,6.6');
  assert.equal(q({ places: [{ location: { lat: 46.5, lon: 6.6 } }] }), '46.5,6.6');
  assert.equal(q({ lat: 1, lng: 2 }), '1,2');
  assert.equal(q({ places: [{ address: 'Somewhere', lat: 200, lng: 6 }] }), 'Somewhere');
  assert.equal(mapPlaces({ places: [{ lat: 'north', lng: 6 }] }).length, 0);
});

test('nothing to show, junk and too many places are handled', () => {
  assert.deepEqual(mapPlaces({}), []);
  assert.deepEqual(mapPlaces({ places: [null, 3, {}, { note: 'no address' }, '  '] }), []);
  assert.deepEqual(mapPlaces({ places: 'not a list' }), []);
  assert.equal(mapPlaces({ places: Array.from({ length: 50 }, (_, i) => `${i} Main St`) }).length, MAX_PLACES);
});

test("zoom is kept within Google's range, 15 by default", () => {
  assert.equal(mapZoom({}), 15);
  assert.equal(mapZoom({ zoom: 99 }), 21);
  assert.equal(mapZoom({ zoom: '3' }), 3);
  assert.equal(mapZoom({ zoom: 'close' }), 15);
});

test('links: a keyless embed, a search that opens Google Maps, and a route through them in order', () => {
  const [a, b, c] = mapPlaces({ places: ['66 Mint St, San Francisco', 'Ferry Building & Co', { lat: 37.8, lng: -122.4 }] });
  assert.ok(a && b && c);
  assert.equal(embedUrl(a, 12), 'https://maps.google.com/maps?q=66%20Mint%20St%2C%20San%20Francisco&z=12&output=embed');
  assert.equal(openUrl(b), 'https://www.google.com/maps/search/?api=1&query=Ferry%20Building%20%26%20Co');
  assert.equal(routeUrl([a]), null);
  assert.equal(routeUrl([a, c]), 'https://www.google.com/maps/dir/?api=1&origin=66%20Mint%20St%2C%20San%20Francisco&destination=37.8%2C-122.4');
  assert.match(routeUrl([a, b, c]) ?? '', /&waypoints=Ferry%20Building%20%26%20Co$/);
  const many = mapPlaces({ places: Array.from({ length: 14 }, (_, i) => `${i} Main St`) });
  assert.match(routeUrl(many) ?? '', /destination=9%20Main%20St&/, 'at most 10 places in a route');
});

test('the agent is told about the map block, and it is a built-in type', () => {
  assert.match(SYSTEM_PROMPT, /"type":"map","title":"…","places":\[\{"name"[^\n]*"address"/);
  assert.match(SYSTEM_PROMPT, /Open in Google Maps/);
  assert.ok(BUILTIN_BLOCKS.has('map'));
});

test('the markdown export lists each place as a Google Maps link, with the route when asked', () => {
  const out = blocksToMarkdown([{ type: 'map', title: 'Stops', route: true, places: [{ name: 'Office', address: '1 Main St' }, '2 Side St'], caption: 'In order' }]);
  assert.match(out, /\*\*📍 Stops\*\* · \[Route\]\(https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=1%20Main%20St&destination=2%20Side%20St\)/);
  assert.match(out, /1\. \*\*Office\*\* — \[1 Main St\]\(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=1%20Main%20St\)/);
  assert.match(out, /2\. \[2 Side St\]\(/);
  assert.match(out, /In order$/);
  assert.doesNotMatch(blocksToMarkdown([{ type: 'map', places: ['a', 'b'] }]), /Route/);
});
