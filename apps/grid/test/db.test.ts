// grid.db (db.ts, migrations.ts): forward-only migrations, each in its own transaction, a copy
// before an upgrade, and a database newer than the code refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupsDir, openDb } from '../src/db.ts';
import { MIGRATIONS, TABLES } from '../src/migrations.ts';
import { tmp } from './helpers.ts';

// Every table the control plane has, by name. The plan (§4.7) says "29 tables"; grid.db has 25,
// plus meta (the schema counter and the seat numbers): this list is the real count.
const ALL = [
  'users', 'identities', 'sessions', 'devices', 'device_codes', 'tickets', 'instances', 'keys', 'user_secrets', 'audit',
  'computers', 'waitlist', 'load_samples', 'machine_wishes', 'sites', 'shares', 'sandboxes', 'api_keys',
  'channel_urls', 'channel_inbox', 'mail_threads', 'mail_sent', 'channel_routes', 'channel_threads', 'channel_thread_msgs',
];

const tables = (db: Awaited<ReturnType<typeof openDb>>): string[] => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
const schema = (db: Awaited<ReturnType<typeof openDb>>): number => Number(db.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'")?.v);

test('a fresh grid.db gets every migration and every table', async () => {
  const dir = tmp('griddb');
  const db = await openDb(dir);
  assert.deepEqual([...TABLES].sort(), [...ALL].sort());
  assert.deepEqual(tables(db), [...ALL, 'meta'].sort());
  assert.equal(schema(db), MIGRATIONS.length);
  assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
  assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
  db.close();
  assert.ok(!fs.existsSync(backupsDir(dir)), 'nothing to copy on a fresh one');
});

test('opening it again changes nothing', async () => {
  const dir = tmp('griddb');
  const a = await openDb(dir);
  a.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', 'u1', 'ada', 1);
  a.close();
  const b = await openDb(dir);
  assert.equal(schema(b), MIGRATIONS.length);
  assert.equal(b.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', 'u1')?.handle, 'ada');
  b.close();
  assert.ok(!fs.existsSync(backupsDir(dir)), 'no upgrade, no copy');
});

test('a grid.db from before the hub opens as it was: the migration only adds, after a copy', async () => {
  const dir = tmp('griddb');
  const a = await openDb(dir);
  a.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', 'u-ada', 'ada', 1);
  a.raw.exec("DROP TABLE channel_thread_msgs; DROP TABLE channel_threads; DROP TABLE channel_routes; DROP TABLE channel_inbox; DROP TABLE channel_urls; DROP TABLE mail_threads; DROP TABLE mail_sent; UPDATE meta SET v = '8' WHERE k = 'schema';");
  a.close();
  const b = await openDb(dir);
  assert.equal(schema(b), MIGRATIONS.length);
  assert.equal(b.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', 'ada')?.id, 'u-ada');
  for (const t of ['channel_inbox', 'channel_urls', 'mail_threads', 'channel_routes']) assert.equal(b.get<{ n: number }>(`SELECT count(*) n FROM ${t}`)?.n, 0, t);
  assert.ok(b.all<{ name: string }>('PRAGMA table_info(channel_inbox)').some((c) => c.name === 'verified'), 'the last migration’s column is there');
  b.close();
  const copies = fs.readdirSync(backupsDir(dir));
  assert.equal(copies.length, 1);
  assert.match(copies[0] ?? '', /^grid-v8-\d+\.db$/);
  // The copy is the database as it was before: schema 8, Ada in it.
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(path.join(backupsDir(dir), copies[0] ?? ''));
  assert.equal(copy.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.['v'], '8');
  assert.equal(copy.prepare('SELECT handle FROM users').get()?.['handle'], 'ada');
  copy.close();
});

test('a migration that fails is rolled back, and the counter stays where it was', async () => {
  const dir = tmp('griddb');
  const a = await openDb(dir);
  // Migration 11 creates channel_routes: one already there makes it fail half way.
  a.raw.exec("DROP TABLE channel_thread_msgs; DROP TABLE channel_threads; ALTER TABLE channel_inbox DROP COLUMN verified; UPDATE meta SET v = '10' WHERE k = 'schema';");
  a.close();
  await assert.rejects(openDb(dir), /already exists/);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'grid.db'));
  assert.equal(raw.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.['v'], '10');
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'channel_threads'").get()?.['n'], 0, 'nothing of it stays');
  raw.close();
});

test('a grid.db newer than this grid is refused, with where the copies are', async () => {
  const dir = tmp('griddb');
  const a = await openDb(dir);
  a.run("UPDATE meta SET v = ? WHERE k = 'schema'", String(MIGRATIONS.length + 1));
  a.close();
  await assert.rejects(openDb(dir), (err: Error) => {
    assert.match(err.message, new RegExp(`schema v${MIGRATIONS.length + 1}, but this grid only knows up to v${MIGRATIONS.length}`));
    assert.ok(err.message.includes(backupsDir(dir)));
    return true;
  });
});

test('tx: all or nothing; backup: a consistent copy while it’s open', async () => {
  const dir = tmp('griddb');
  const db = await openDb(dir);
  assert.throws(() =>
    db.tx(() => {
      db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', 'u1', 'ada', 1);
      throw new Error('stop');
    }),
  );
  assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM users')?.n, 0);
  assert.equal(db.tx(() => (db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', 'u2', 'bo', 1), 7)), 7);
  const file = path.join(dir, 'copy.db');
  fs.writeFileSync(file, 'old');
  db.backup(file);
  db.close();
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(file);
  assert.equal(c.prepare('SELECT handle FROM users').get()?.['handle'], 'bo');
  c.close();
});
