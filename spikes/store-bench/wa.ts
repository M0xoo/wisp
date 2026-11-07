// Write amplification while streaming (plan §8: ≤ 15× payload): one 2 MB session streamed as 5,000
// events through @wisp/store, with the session head patched in the same transaction (as the runtime
// does). Bytes written = every WAL frame (a reader pins the WAL so it only grows) + the database file
// after the final checkpoint (each page written once more). Payload = the events' JSON.
//   run: node spikes/store-bench/wa.ts [--batch=10]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@wisp/store';
import type { Row } from '@wisp/store';

const BATCH = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 10);
const EVENTS = 5000;
const TARGET = 2 * 1024 * 1024;

function run(batch: number): { payload: number; written: number; wal: number; db: number } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-wa-'));
  const file = path.join(home, 'wisp.db');
  const store = openStore({ path: file });
  store.migrate('bench', [
    {
      version: 1,
      up: `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, state TEXT, updated_at INTEGER, last_seq INTEGER, extra TEXT) STRICT;
           CREATE TABLE event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT, body TEXT, v INTEGER) STRICT;
           CREATE UNIQUE INDEX event_seq ON event (session_id, seq);`,
    },
  ]);
  const session = store.defineEntity({
    kind: 'session',
    table: 'session',
    key: 'id',
    columns: { id: 'text', title: 'text', state: 'text', updated_at: 'int', last_seq: 'int', extra: 'text' },
    json: ['extra'],
    topics: (r: Row) => ['list', `session:${String(r['id'])}`],
  });
  const event = store.defineEntity({
    kind: 'event',
    table: 'event',
    key: 'id',
    parent: 'session_id',
    log: true,
    columns: { id: 'int', session_id: 'text', seq: 'int', kind: 'text', body: 'text', v: 'int' },
    json: ['body'],
    topics: (r: Row) => [`session:${String(r['session_id'])}`],
  } as Parameters<typeof store.defineEntity>[0]);
  store.tx((w) => w.upsert(session, { id: 's1', title: 'the big one', state: 'running', updated_at: 0, last_seq: 0, extra: { cost: 0 } }));
  // A reader holding a snapshot from before the stream keeps every checkpoint from copying frames
  // back, so the WAL only grows: its size is then every frame the stream wrote.
  const reader = new DatabaseSync(file);
  reader.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM session').get();
  const bodyText = "x".repeat(Math.floor(TARGET / EVENTS) - 31); // {"t":"text","text":…,"n":1234} ≈ 419 B
  let payload = 0;
  for (let i = 0; i < EVENTS; i += batch) {
    const rows = Array.from({ length: Math.min(batch, EVENTS - i) }, (_, k) => {
      const body = { t: 'text', text: bodyText, n: i + k };
      payload += JSON.stringify(body).length;
      return { session_id: 's1', seq: i + k, kind: 'text', body, v: 1 };
    });
    store.tx((w) => {
      w.append(event, rows);
      w.patch(session, 's1', [{ op: 'replace', path: '/last_seq', value: i + rows.length }, { op: 'replace', path: '/updated_at', value: i }]);
    });
  }
  const wal = fs.statSync(`${file}-wal`).size;
  reader.exec('COMMIT');
  reader.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  reader.close();
  store.close();
  const dbBytes = fs.statSync(file).size;
  fs.rmSync(home, { recursive: true, force: true });
  return { payload, written: wal + dbBytes, wal, db: dbBytes };
}

const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
for (const b of [BATCH, 1]) {
  const r = run(b);
  process.stdout.write(`tx per ${b} events: payload ${mb(r.payload)}, WAL ${mb(r.wal)}, db ${mb(r.db)} → ${(r.written / r.payload).toFixed(1)}× payload\n`);
}
