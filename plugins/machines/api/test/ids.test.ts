import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualify, secretKey, splitId, TransportError } from '../src/index.ts';

test('v1 ids: <id>@<machine>, split at the last @, local ids have none', () => {
  assert.equal(qualify('abc123', 'm1'), 'abc123@m1');
  assert.equal(qualify('', 'm1'), '');
  assert.deepEqual(splitId('abc123@m1'), { id: 'abc123', machine: 'm1' });
  assert.deepEqual(splitId('a@b@m1'), { id: 'a@b', machine: 'm1' });
  assert.equal(splitId('abc123'), null);
  assert.equal(splitId('@m1'), null);
});

test('a transport error keeps its hint and whether to give up', () => {
  const e = new TransportError({ message: 'no', hint: { text: 'why' }, giveUp: true, kind: 'gone' });
  assert.equal(e.message, 'no');
  assert.deepEqual(e.hint, { text: 'why' });
  assert.equal(e.giveUp, true);
  assert.equal(e.kind, 'gone');
  assert.ok(!('hint' in new TransportError({ message: 'x' })));
  assert.equal(secretKey('ab12cd'), 'machines.ab12cd');
});
