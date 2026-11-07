// The contract's names follow the kernel's rules: ids carry the plugin's prefix, permissions parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, EVENTS, KINDS, PERMISSIONS, POINTS, SETTINGS, TOPIC } from '../src/index.ts';

test('every command, event and point is accounts.*, every permission accounts:*', () => {
  for (const id of [...Object.values(COMMANDS), ...Object.values(EVENTS), ...Object.values(POINTS)]) assert.match(id, /^accounts\.[a-z][\w.]*$/, id);
  for (const p of Object.values(PERMISSIONS)) assert.match(p, /^accounts:[a-z]+$/, p);
  assert.equal(new Set(Object.values(COMMANDS)).size, Object.values(COMMANDS).length, 'no id twice');
});

test('v1 names stay: the setting key and the kinds', () => {
  assert.equal(SETTINGS.pick, 'accounts');
  assert.deepEqual(KINDS, ['personal', 'work']);
  assert.match(TOPIC, /^plugin:accounts:/);
});
