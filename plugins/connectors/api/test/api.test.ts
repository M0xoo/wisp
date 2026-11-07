import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRIDGE, COMMANDS, EVENTS, REACH } from '@wisp-plugin/connectors-api';

test('every command is a connectors: permission, and the bridge maps each method to one', () => {
  for (const id of Object.values(COMMANDS)) assert.match(id, /^connectors\.[a-zA-Z.]+$/);
  assert.deepEqual(Object.keys(BRIDGE.permissions).sort(), ['launcher', 'token', 'url']);
  assert.ok(Object.values(EVENTS).every((e) => e.startsWith('connectors.')));
  assert.deepEqual([...REACH], ['claude', 'codex', 'copilot', 'opencode', 'grok']);
});
