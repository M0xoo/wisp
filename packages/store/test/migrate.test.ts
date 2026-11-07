import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/index.ts';
import type { Migration, StoreError } from '../src/index.ts';
import { tmpHome } from './fixture.ts';

const V1: Migration[] = [{ version: 1, up: 'CREATE TABLE crew_member (id TEXT PRIMARY KEY, name TEXT) STRICT' }];
const V2: Migration[] = [
  ...V1,
  { version: 2, up: 'ALTER TABLE crew_member ADD COLUMN role TEXT' },
  {
    version: 3,
    up: (db) => {
      db.prepare("UPDATE crew_member SET role = 'helper' WHERE role IS NULL").run();
    },
  },
];

function at(home: string, now = 5000): ReturnType<typeof openStore> {
  return openStore({ path: path.join(home, 'wisp.db'), clock: { now: () => now } });
}

test('a fresh database: kernel and owner migrate from v0 with no snapshot', () => {
  const home = tmpHome();
  const store = at(home);
  assert.equal(store.schemaVersion('kernel'), 1);
  assert.deepEqual(store.migrate('crew', V1), { from: 0, to: 1 });
  assert.equal(store.schemaVersion('crew'), 1);
  assert.deepEqual(store.migrate('crew', V1), { from: 1, to: 1 }, 'running again is a no-op');
  assert.equal(fs.existsSync(path.join(home, 'backups')), false);
  store.close();
});

test('an upgrade snapshots the database first, then runs each step in order', () => {
  const home = tmpHome();
  let store = at(home);
  store.migrate('crew', V1);
  store.close();
  store = at(home, 7000);
  const report = store.migrate('crew', V2);
  assert.equal(report.from, 1);
  assert.equal(report.to, 3);
  assert.equal(report.snapshot, path.join(home, 'backups', 'crew-v1-7000.db'));
  assert.ok(fs.existsSync(report.snapshot as string));
  store.close();
  const snap = openStore({ path: report.snapshot as string });
  assert.equal(snap.schemaVersion('crew'), 1, 'the snapshot holds the database as it was');
  snap.close();
});

test('the data survives an upgrade, and a function migration sees the new column', () => {
  const home = tmpHome();
  let store = at(home);
  store.migrate('crew', V1);
  const member = store.defineEntity({ kind: 'member', table: 'crew_member', key: 'id', columns: { id: 'text', name: 'text' }, topics: () => ['crew'] });
  store.tx((w) => w.upsert(member, { id: 'm1', name: 'Ada' }));
  store.close();
  store = at(home);
  store.migrate('crew', V2);
  const v2 = store.defineEntity({ kind: 'member', table: 'crew_member', key: 'id', columns: { id: 'text', name: 'text', role: 'text' }, topics: () => ['crew'] });
  assert.deepEqual(store.get(v2, 'm1'), { id: 'm1', name: 'Ada', role: 'helper' });
  store.close();
});

test('a database newer than the code is refused with a clear error', () => {
  const home = tmpHome();
  let store = at(home);
  store.migrate('crew', V2);
  store.close();
  store = at(home);
  assert.throws(
    () => store.migrate('crew', V1),
    (err: StoreError) => err.code === 'conflict' && /crew schema v3, but this wisp only knows up to v1/.test(err.message),
  );
  assert.equal(store.schemaVersion('crew'), 3, 'nothing was touched');
  store.close();
});

test('a failing migration rolls back that step only and keeps the version it reached', () => {
  const store = openStore({ path: ':memory:' });
  const bad: Migration[] = [...V1, { version: 2, up: 'ALTER TABLE crew_member ADD COLUMN x TEXT; THIS IS NOT SQL' }];
  assert.throws(() => store.migrate('crew', bad), /crew migration v2 failed/);
  assert.equal(store.schemaVersion('crew'), 1);
  const cols = store.query('plugin'); // the store still works
  assert.deepEqual(cols, []);
});

test('migration lists must be numbered 1..n, owners well-formed, and never run inside a tx', () => {
  const store = openStore({ path: ':memory:' });
  assert.throws(() => store.migrate('crew', [{ version: 2, up: '' }]), /numbered 1, 2, 3/);
  assert.throws(() => store.migrate('Bad Owner', V1), /bad migration owner/);
  assert.throws(() => store.tx(() => store.migrate('crew', V1)), /inside a transaction/);
});

test('a table rebuild with foreign keys off is checked before it commits', () => {
  const store = openStore({ path: ':memory:' });
  store.migrate('crew', [
    { version: 1, up: 'CREATE TABLE crew_team (id TEXT PRIMARY KEY) STRICT; CREATE TABLE crew_seat (id TEXT PRIMARY KEY, team TEXT REFERENCES crew_team (id)) STRICT' },
  ]);
  const broken: Migration = { version: 2, foreignKeysOff: true, up: "INSERT INTO crew_seat VALUES ('s', 'ghost')" };
  assert.throws(() => store.migrate('crew', [{ version: 1, up: '' }, broken]), /broken foreign keys/);
  assert.equal(store.schemaVersion('crew'), 1);
});

test('old snapshots are pruned: three per owner are kept', () => {
  const home = tmpHome();
  const steps: Migration[] = [{ version: 1, up: 'CREATE TABLE crew_x (id TEXT PRIMARY KEY) STRICT' }];
  for (let v = 2; v <= 6; v++) {
    steps.push({ version: v, up: `ALTER TABLE crew_x ADD COLUMN c${v} TEXT` });
    const store = at(home, 1000 * v);
    store.migrate('crew', steps);
    store.close();
  }
  const kept = fs.readdirSync(path.join(home, 'backups')).sort();
  assert.deepEqual(kept, ['crew-v3-4000.db', 'crew-v4-5000.db', 'crew-v5-6000.db']);
});
