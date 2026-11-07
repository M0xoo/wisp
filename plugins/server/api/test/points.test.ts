import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POINTS, SERVER_ID } from '../src/index.ts';

test('every point of wisp.server carries its owner prefix', () => {
  for (const id of Object.values(POINTS)) assert.ok(id.startsWith('server.'), id);
  assert.equal(SERVER_ID, 'wisp.server');
});
