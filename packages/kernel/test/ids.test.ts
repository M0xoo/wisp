import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asPeerId, asPluginId, brander, formatOriginId, isPluginId, isUuid, isUuidV7, localName, ownedBy, ownerPrefix, parseOriginId, uuidv7, uuidv7Time } from '../src/index.ts';

test('uuidv7 has the version and variant bits and carries its millisecond', () => {
  const at = Date.UTC(2026, 10, 7, 12, 0, 0);
  const id = uuidv7(at);
  assert.ok(isUuidV7(id), id);
  assert.ok(isUuid(id));
  assert.equal(uuidv7Time(id), at);
  assert.throws(() => uuidv7Time('not-an-id'), /not a UUIDv7/);
});

test('uuidv7 sorts by creation, even many in one millisecond', () => {
  const ids: string[] = [];
  for (let i = 0; i < 5000; i++) ids.push(uuidv7(1_700_000_000_000)); // > 4096: the counter overflows into the next ms
  for (let t = 1_700_000_000_100; t < 1_700_000_000_110; t++) ids.push(uuidv7(t));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test('uuidv7 never goes backwards when the clock does', () => {
  const a = uuidv7(1_800_000_000_000);
  const b = uuidv7(1_000);
  assert.ok(b > a);
});

test('branded ids are checked when made', () => {
  assert.equal(asPluginId('wisp.runtime'), 'wisp.runtime');
  assert.throws(() => asPluginId('Runtime'), /not a PluginId/);
  assert.throws(() => asPluginId('runtime'), /not a PluginId/); // one segment: no owner
  assert.ok(isPluginId('user.my-prs'));
  assert.ok(!isPluginId(3));
  assert.equal(asPeerId('mac-mini_2'), 'mac-mini_2');
  assert.throws(() => asPeerId('has space'));
  const asTicket = brander<string & { readonly __brand: 'Ticket' }>('Ticket', (s) => s.startsWith('T-'));
  assert.equal(asTicket('T-1'), 'T-1');
  assert.throws(() => asTicket('1'), /not a Ticket/);
});

test('origin ids round-trip and refuse what is not one', () => {
  const u = uuidv7();
  const o = formatOriginId('laptop', u);
  assert.equal(o, `laptop:${u}`);
  assert.deepEqual(parseOriginId(o), { peer: 'laptop', id: u });
  assert.ok(formatOriginId('box-1').startsWith('box-1:'));
  assert.equal(parseOriginId(u), undefined); // no peer
  assert.equal(parseOriginId(':' + u), undefined);
  assert.equal(parseOriginId('laptop:nope'), undefined);
  assert.equal(parseOriginId('bad peer:' + u), undefined);
  assert.throws(() => formatOriginId('bad peer', u), /PeerId/);
  assert.throws(() => formatOriginId('laptop', 'x'), /UUID/);
});

test('owner prefixes: the id minus its author, the full id works too', () => {
  assert.equal(ownerPrefix('wisp.claude'), 'claude');
  assert.equal(ownerPrefix('wisp.shell.task'), 'shell.task');
  assert.equal(ownerPrefix('solo'), 'solo');
  assert.ok(ownedBy('claude.login', 'wisp.claude'));
  assert.ok(ownedBy('claude', 'wisp.claude'));
  assert.ok(ownedBy('wisp.claude.login', 'wisp.claude'));
  assert.ok(!ownedBy('claudex.login', 'wisp.claude'));
  assert.ok(!ownedBy('runtime.start', 'wisp.claude'));
  assert.equal(localName('runtime.start', 'wisp.runtime'), 'start');
  assert.equal(localName('wisp.runtime.start', 'wisp.runtime'), 'start');
  assert.equal(localName('other', 'wisp.runtime'), 'other');
});
