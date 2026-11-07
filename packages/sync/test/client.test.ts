// SyncClient rules, one by one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMessage, ServerMessage, Welcome } from '@wisp/protocol';
import { SyncClient } from '../src/client.ts';
import type { ClientOutput } from '../src/types.ts';
import { PEER } from './harness.ts';

const welcome = (over: Partial<Welcome> = {}): Welcome => ({ t: 'welcome', epoch: 'E1', head_seq: 10, oldest_seq: 0, resume: false, proto: 2, peer: PEER, ...over });
const sent = (outs: ClientOutput[]): ClientMessage[] => outs.flatMap((o) => (o.kind === 'send' ? [o.message] : []));
const kinds = (outs: ClientOutput[]): string[] => outs.map((o) => o.kind);

function live(c: SyncClient, w: Partial<Welcome> = {}, id = 10): ClientOutput[] {
  c.handle({ kind: 'open' }, 0);
  return c.handle({ kind: 'frame', id, messages: [welcome(w)] }, 0);
}

const newClient = (over: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}): SyncClient => new SyncClient({ peer: 'laptop', clientId: 'tab1', build: 'b1', ...over });

test('two views of one session are one sub; the last one out unsubscribes', () => {
  const c = newClient();
  live(c);
  assert.deepEqual(sent(c.handle({ kind: 'subscribe', topic: 'session:a' }, 0)), [{ t: 'sub', topic: 'session:a' }]);
  assert.deepEqual(sent(c.handle({ kind: 'subscribe', topic: 'session:a' }, 0)), []);
  assert.deepEqual(sent(c.handle({ kind: 'unsubscribe', topic: 'session:a' }, 0)), []);
  assert.deepEqual(sent(c.handle({ kind: 'unsubscribe', topic: 'session:a' }, 0)), [{ t: 'unsub', topic: 'session:a' }]);
});

test('passive refs: a passive-only topic is a passive sub; the first active view makes it count', () => {
  const c = newClient();
  live(c);
  assert.deepEqual(sent(c.handle({ kind: 'subscribe', topic: 'machines', passive: true }, 0)), [{ t: 'sub', topic: 'machines', passive: true }]);
  assert.deepEqual(sent(c.handle({ kind: 'subscribe', topic: 'machines' }, 0)), [{ t: 'sub', topic: 'machines' }]);
  assert.deepEqual(sent(c.handle({ kind: 'unsubscribe', topic: 'machines' }, 0)), [{ t: 'sub', topic: 'machines', passive: true }]);
});

test('the hello: proto window, cursor for this epoch, resumed and fresh topics, passive ones', () => {
  const c = newClient({ saved: { epoch: 'E1', cursor: 42, synced: ['list'], pending: [] } });
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  c.handle({ kind: 'subscribe', topic: 'session:a' }, 0);
  c.handle({ kind: 'subscribe', topic: 'machines', passive: true }, 0);
  const req = c.handle({ kind: 'open' }, 0).find((o) => o.kind === 'request');
  assert.deepEqual(req, { kind: 'request', params: { proto_min: '2', proto_max: '2', client_id: 'tab1', build: 'b1', epoch: 'E1', cursor: '42', topics: 'list', fresh: 'session:a,machines', passive: 'machines' } });
  // a resumed welcome keeps the rows; the cursor moves to the frame's id
  const outs = c.handle({ kind: 'frame', id: 42, messages: [welcome({ resume: true })] }, 0);
  assert.ok(!kinds(outs).includes('reset'));
  assert.equal(c.state, 'live');
  assert.deepEqual(c.save(), { epoch: 'E1', cursor: 42, synced: ['list'], pending: [] });
});

test('resume=false or a new epoch drops the caches for this peer', () => {
  const c = newClient({ saved: { epoch: 'E1', cursor: 42, synced: ['list'], pending: [] } });
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  assert.ok(kinds(live(c, { resume: false })).includes('reset'));
  const d = newClient({ saved: { epoch: 'E1', cursor: 42, synced: ['list'], pending: [] } });
  d.handle({ kind: 'subscribe', topic: 'list' }, 0);
  assert.ok(kinds(live(d, { resume: true, epoch: 'E2' })).includes('reset'), 'a resume from another epoch is not trusted');
  assert.equal(d.epoch, 'E2');
});

test('pending mutations go again after welcome, with the same mid, until ack or reject', () => {
  const c = newClient();
  c.handle({ kind: 'mutate', mid: 'm1', cmd: 'session.followUp', args: { text: 'hi' } }, 0);
  assert.deepEqual(sent(live(c)), [{ t: 'mutate', mid: 'm1', cmd: 'session.followUp', args: { text: 'hi' } }]);
  c.handle({ kind: 'lost' }, 0);
  const again = live(c);
  assert.deepEqual(sent(again).map((m) => m.t === 'mutate' && m.mid), ['m1'], 'a flaky tunnel: same key, never run twice');
  // the ack comes after the frame's ops, so base has the effect before the optimistic patch goes
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  c.handle({ kind: 'frame', id: 11, messages: [{ t: 'snapshot', topic: 'list', seq: 11, rows: [] }] }, 0);
  const outs = c.handle({ kind: 'frame', id: 12, messages: [{ t: 'ack', mid: 'm1', seq: 12 }, { t: 'patch', seq: 12, ops: [{ topic: 'list', e: 's', id: '1', op: 'upsert', v: 1 }] }] }, 0);
  assert.deepEqual(kinds(outs), ['entityOps', 'ack']);
  assert.deepEqual(c.save().pending, []);
  c.handle({ kind: 'mutate', mid: 'm2', cmd: 'x', args: null }, 0);
  const rej = c.handle({ kind: 'frame', id: 12, messages: [{ t: 'reject', mid: 'm2', code: 'forbidden', message: 'no' }] }, 0);
  assert.deepEqual(rej.filter((o) => o.kind === 'reject'), [{ kind: 'reject', mid: 'm2', code: 'forbidden', message: 'no' }]);
});

test('version window: outside it, the side that is older must update', () => {
  const old = newClient({ protoMin: 1, protoMax: 1 });
  assert.deepEqual(live(old).filter((o) => o.kind === 'state' && o.state === 'incompatible'), [{ kind: 'state', state: 'incompatible', update: 'client' }]);
  assert.equal(old.state, 'incompatible');
  assert.deepEqual(old.handle({ kind: 'lost' }, 0), [], 'no retry loop against a peer it cannot speak to');
  const ahead = newClient({ protoMin: 5, protoMax: 7 });
  assert.deepEqual(live(ahead), [{ kind: 'state', state: 'incompatible', update: 'peer' }], 'nothing else in the frame counts');
  assert.equal(ahead.state, 'incompatible');
  // overlapping windows speak the highest both know
  assert.deepEqual(live(newClient({ protoMin: 2, protoMax: 4 })).filter((o) => o.kind === 'state'), [{ kind: 'state', state: 'live' }]);
});

test('snapshot pages are joined; a page at another seq starts over', () => {
  const c = newClient();
  live(c);
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  const page = (seq: number, id: string, more: boolean): ServerMessage => ({ t: 'snapshot', topic: 'list', seq, rows: [{ e: 's', id, v: id }], ...(more && { more: true }) });
  assert.deepEqual(c.handle({ kind: 'frame', id: 10, messages: [page(10, 'a', true)] }, 0), []);
  // the server started the topic over at a later seq: the old pages are worthless
  const outs = c.handle({ kind: 'frame', id: 12, messages: [page(12, 'b', true), page(12, 'c', false)] }, 0);
  assert.deepEqual(outs, [{ kind: 'snapshot', peer: 'laptop', topic: 'list', rows: [{ e: 's', id: 'b', v: 'b' }, { e: 's', id: 'c', v: 'c' }] }]);
});

test('ops for a topic still waiting for its snapshot are ignored', () => {
  const c = newClient();
  live(c);
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  const op = { topic: 'list' as const, e: 's', id: '1', op: 'patch' as const, ops: [] };
  assert.deepEqual(c.handle({ kind: 'frame', id: 11, messages: [{ t: 'patch', seq: 11, ops: [op] }] }, 0), []);
});

test('resync: a synced topic resubscribes from the cursor, one never synced starts fresh', () => {
  const c = newClient();
  live(c);
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  c.handle({ kind: 'subscribe', topic: 'session:a' }, 0);
  c.handle({ kind: 'frame', id: 15, messages: [{ t: 'snapshot', topic: 'list', seq: 15, rows: [] }] }, 0);
  const outs = c.handle({ kind: 'frame', id: 14, messages: [{ t: 'resync', topic: 'list' }, { t: 'resync', topic: 'session:a' }] }, 0);
  assert.deepEqual(kinds(outs), ['needResubscribe', 'send', 'needResubscribe', 'send']);
  // the frame's id is the watermark, even when it is lower than the last one
  assert.deepEqual(sent(outs), [{ t: 'sub', topic: 'list', since: 14 }, { t: 'sub', topic: 'session:a' }]);
  assert.equal(c.cursor, 14);
});

test('denied topics are reported and left out of the next hello', () => {
  const c = newClient();
  c.handle({ kind: 'subscribe', topic: 'session:secret' }, 0);
  live(c);
  const outs = c.handle({ kind: 'frame', id: 10, messages: [{ t: 'notice', kind: 'denied', data: { topic: 'session:secret', code: 'forbidden' } }, { t: 'notice', kind: 'toast', data: 'hi' }] }, 0);
  assert.deepEqual(outs, [{ kind: 'denied', topic: 'session:secret', code: 'forbidden' }, { kind: 'notice', notice: { t: 'notice', kind: 'toast', data: 'hi' } }]);
  c.handle({ kind: 'lost' }, 0);
  const req = c.handle({ kind: 'open' }, 0).find((o) => o.kind === 'request');
  assert.equal(req?.kind === 'request' && req.params['fresh'], undefined);
});

test('lost: retries back off exponentially to a cap, and reset after a welcome', () => {
  const c = newClient({ retryBaseMs: 500, retryMaxMs: 4000 });
  c.handle({ kind: 'open' }, 0);
  const at: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = c.handle({ kind: 'lost' }, 1000).find((o) => o.kind === 'retry');
    at.push(r?.kind === 'retry' ? r.at - 1000 : -1);
    c.handle({ kind: 'open' }, 1000);
  }
  assert.deepEqual(at, [500, 1000, 2000, 4000, 4000, 4000]);
  c.handle({ kind: 'frame', id: 1, messages: [welcome()] }, 0);
  const r = c.handle({ kind: 'lost' }, 0).find((o) => o.kind === 'retry');
  assert.deepEqual(r, { kind: 'retry', at: 500 });
});

test('subs and unsubs made while connecting are sent after the welcome', () => {
  const c = newClient();
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  c.handle({ kind: 'open' }, 0);
  c.handle({ kind: 'subscribe', topic: 'session:a' }, 0);
  c.handle({ kind: 'unsubscribe', topic: 'list' }, 0);
  const outs = c.handle({ kind: 'frame', id: 10, messages: [welcome()] }, 0);
  assert.deepEqual(sent(outs), [{ t: 'sub', topic: 'session:a' }, { t: 'unsub', topic: 'list' }]);
});

test('a drifted topic starts over: unsub, then a fresh sub', () => {
  const c = newClient();
  live(c);
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  assert.deepEqual(sent(c.handle({ kind: 'drifted', topic: 'list' }, 0)), [{ t: 'unsub', topic: 'list' }, { t: 'sub', topic: 'list' }]);
});
