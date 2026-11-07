import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMatch } from '../src/index.ts';
import { open, sessionRow } from './fixture.ts';

test('search finds rows by words and prefix, follows patches and deletes', () => {
  const { store, session } = open();
  store.tx((w) => {
    w.upsert(session, sessionRow('a', { title: 'Fix the login rate limiter' }));
    w.upsert(session, sessionRow('b', { title: 'Rate card for pricing' }));
  });
  store.defineSearch(session, ['title']);
  const ids = (q: string): string[] => store.search(q).map((h) => h.id).sort();
  assert.deepEqual(ids('rate'), ['a', 'b'], 'rows that existed before the index are indexed');
  assert.deepEqual(ids('login lim'), ['a'], 'every word, the last as a prefix');
  store.tx((w) => w.patch(session, 'b', [{ op: 'replace', path: '/title', value: 'Pricing page' }]));
  assert.deepEqual(ids('rate'), ['a']);
  assert.deepEqual(ids('pricing'), ['b']);
  store.tx((w) => w.del(session, 'a'));
  assert.deepEqual(ids('login'), []);
  store.tx((w) => w.upsert(session, sessionRow('c', { title: 'login again' })));
  assert.deepEqual(ids('login'), ['c']);
});

test('query syntax in what someone types is text, never an FTS5 error', () => {
  const { store, session } = open();
  store.defineSearch(session, ['title', 'extra']);
  store.tx((w) => w.upsert(session, sessionRow('a', { title: 'NOT "quoted" a-b:c', extra: { note: 'AND OR' } })));
  for (const q of ['"', 'a-b:c', 'NOT', '(', '*', 'AND OR', 'quoted"', '']) assert.doesNotThrow(() => store.search(q), q);
  assert.deepEqual(store.search('quoted').map((h) => h.id), ['a']);
  assert.deepEqual(store.search('note').map((h) => h.id), ['a'], 'json columns are indexed as their text');
  assert.equal(toMatch('  say "hi"  '), '"say" """hi"""*');
});

test('a rolled-back write leaves the index as it was; the index survives reopen', () => {
  const { store, session, home } = open({ disk: true });
  store.defineSearch(session, ['title']);
  store.tx((w) => w.upsert(session, sessionRow('a', { title: 'alpha' })));
  assert.throws(() =>
    store.tx((w) => {
      w.patch(session, 'a', [{ op: 'replace', path: '/title', value: 'beta' }]);
      throw new Error('no');
    }),
  );
  assert.deepEqual(store.search('alpha').map((h) => h.id), ['a']);
  assert.deepEqual(store.search('beta'), []);
  store.close();
  const again = open({ disk: true, home: home as string });
  again.store.defineSearch(again.session, ['title']);
  assert.deepEqual(again.store.search('alpha').map((h) => h.id), ['a']);
  again.store.defineSearch(again.session, ['title', 'state']);
  assert.deepEqual(again.store.search('idle').map((h) => h.id), ['a'], 'a new column list rebuilds the index');
  again.store.close();
});

test('search across kinds, limited, and refusing a kind with no index', () => {
  const { store, session, event } = open();
  store.defineSearch(session, ['title']);
  store.defineSearch(event, ['body']);
  store.tx((w) => {
    w.upsert(session, sessionRow('a', { title: 'deploy grid' }));
    w.append(event, [{ session_id: 'a', seq: 1, kind: 'text', body: { text: 'deploy finished' } }]);
  });
  assert.deepEqual(store.search('deploy').map((h) => h.kind).sort(), ['event', 'session']);
  assert.equal(store.search('deploy', { limit: 1 }).length, 1);
  assert.deepEqual(store.search('deploy', { kinds: ['event'] }).map((h) => h.id), ['1']);
  assert.throws(() => store.search('x', { kinds: ['plugin'] }), /no search index/);
  assert.throws(() => store.defineSearch(session, ['nope']), /unknown column/);
});
