// Gate G1 (plan §9.1): does the store hold at scale? 5k sessions and 2M events in node:sqlite, through
// @wisp/store's one write path (every append also writes its change row).
//   pass: list query ≤ 5 ms, append ≥ 20k events/s
//   run:  node spikes/store-bench/g1.ts [--events=2000000] [--sessions=5000] [--keep]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '@wisp/store';
import type { Row } from '@wisp/store';

const arg = (name: string, def: number): number => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const SESSIONS = arg('sessions', 5000);
const EVENTS = arg('events', 2_000_000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-g1-'));
const store = openStore({ path: path.join(home, 'wisp.db') });

// The plan §4.1 shapes.
store.migrate('bench', [
  {
    version: 1,
    up: `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, crew_id TEXT, title TEXT, state TEXT,
           agent TEXT, model TEXT, mode TEXT, cwd TEXT, branch TEXT, archived INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER, updated_at INTEGER, last_seq INTEGER, rev INTEGER, extra TEXT) STRICT;
         CREATE INDEX session_list ON session (archived, updated_at DESC);
         CREATE TABLE event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT,
           t INTEGER, kind TEXT, body TEXT, v INTEGER) STRICT;
         CREATE UNIQUE INDEX event_seq ON event (session_id, seq);`,
  },
]);
const text = 'text';
const int = 'int';
const session = store.defineEntity({
  kind: 'session',
  table: 'session',
  key: 'id',
  columns: { id: text, project_id: text, parent_id: text, crew_id: text, title: text, state: text, agent: text, model: text, mode: text, cwd: text, branch: text, archived: 'bool', created_at: int, updated_at: int, last_seq: int, rev: int, extra: text },
  json: ['extra'],
  topics: (r: Row) => ['list', `session:${String(r['id'])}`],
});
const event = store.defineEntity({
  kind: 'event',
  table: 'event',
  key: 'id',
  parent: 'session_id',
  columns: { id: int, session_id: text, seq: int, turn_id: text, t: int, kind: text, body: text, v: int },
  json: ['body'],
  topics: (r: Row) => [`session:${String(r['session_id'])}`],
});

const sid = (i: number): string => `0193${String(i).padStart(8, '0')}-7000-7000-8000-000000000000`;
const nextSeq = new Map<string, number>();
const BODY = { text: 'Reading server/store.js to see how sessions are written', tool: 'Read', input: { file_path: '/Users/x/wisp/server/store.js' } };
function events(s: string, n: number): Row[] {
  const seq0 = nextSeq.get(s) ?? 0;
  nextSeq.set(s, seq0 + n);
  return Array.from({ length: n }, (_, i) => ({ session_id: s, seq: seq0 + i, turn_id: `${s}:t${Math.floor((seq0 + i) / 50)}`, t: 1_700_000_000_000 + seq0 + i, kind: i % 3 ? 'tool' : 'text', body: BODY, v: 1 }));
}

const log = (s: string): void => void process.stdout.write(`${s}\n`);
log(`G1: ${SESSIONS} sessions, ${EVENTS.toLocaleString('en')} events, node ${process.version}, ${os.cpus()[0]?.model ?? '?'}`);

// 1. sessions
let t0 = performance.now();
for (let b = 0; b < SESSIONS; b += 500) {
  store.tx((w) => {
    for (let i = b; i < Math.min(SESSIONS, b + 500); i++) {
      w.upsert(session, { id: sid(i), project_id: `p${i % 12}`, parent_id: null, crew_id: null, title: `Task number ${i}: fix the thing in module ${i % 97}`, state: 'idle', agent: 'claude', model: 'opus', mode: 'auto', cwd: `/Users/x/code/p${i % 12}`, branch: `wisp/task-${i}`, archived: i % 5 === 0, created_at: i, updated_at: 1_700_000_000_000 + i * 1000, last_seq: 0, rev: 1, extra: { cost: i / 100, tags: ['a'] } });
    }
  });
}
log(`  sessions written: ${(performance.now() - t0).toFixed(0)} ms`);

// 2. bulk load: 2M events in transactions of 1,000 (an import's shape)
const BULK = 1000;
t0 = performance.now();
let written = 0;
let s = 0;
while (written < EVENTS) {
  const n = Math.min(BULK, EVENTS - written);
  store.tx((w) => {
    // 10 sessions per tx, 100 events each
    for (let k = 0; k < n; k += 100) w.append(event, events(sid(s++ % SESSIONS), Math.min(100, n - k)));
  });
  written += n;
  if (written % 500_000 === 0) log(`  … ${written.toLocaleString('en')} events, ${((written / (performance.now() - t0)) * 1000).toFixed(0)} ev/s`);
}
const bulkMs = performance.now() - t0;
const bulkRate = (EVENTS / bulkMs) * 1000;
log(`  bulk append: ${bulkRate.toFixed(0)} events/s (${(bulkMs / 1000).toFixed(1)} s)`);

// 3. streaming append on the full DB: one tx per batch of 10 events (plan §2.3's shape), 10 sessions round-robin
const STREAM = 100_000;
t0 = performance.now();
for (let i = 0; i < STREAM / 10; i++) store.tx((w) => w.append(event, events(sid(i % 10), 10)));
const streamRate = (STREAM / (performance.now() - t0)) * 1000;
log(`  streaming append (tx per 10 events): ${streamRate.toFixed(0)} events/s`);

// 4. single-event transactions (worst case, no coalescing)
const SINGLE = 10_000;
t0 = performance.now();
for (let i = 0; i < SINGLE; i++) store.tx((w) => w.append(event, events(sid(i % 10), 1)));
const singleRate = (SINGLE / (performance.now() - t0)) * 1000;
log(`  one event per tx: ${singleRate.toFixed(0)} events/s`);

// 5. reads
function timeit(name: string, runs: number, fn: () => unknown): number {
  for (let i = 0; i < 20; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    fn();
    ms.push(performance.now() - a);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[Math.floor(runs / 2)] ?? 0;
  const p95 = ms[Math.floor(runs * 0.95)] ?? 0;
  log(`  ${name}: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
  return p95;
}
// The list shows a row's summary, not all of it: these are the columns a list row needs.
const LIST = ['id', 'project_id', 'parent_id', 'crew_id', 'title', 'state', 'agent', 'archived', 'updated_at', 'branch'] as const;
const listAll = timeit('list query, every live session (4,000 rows, list columns)', 200, () => store.query(session, { select: LIST, where: { archived: false }, order: [['updated_at', 'desc']] }));
const listFull = timeit('list query, every live session (4,000 rows, all 17 columns)', 200, () => store.query(session, { where: { archived: false }, order: [['updated_at', 'desc']] }));
const listPage = timeit('list query, first 200 rows (one virtualized screen, all columns)', 500, () => store.query(session, { where: { archived: false }, order: [['updated_at', 'desc']], limit: 200 }));
timeit('last 100 events of one session', 500, () => store.query(event, { where: { session_id: sid(1234) }, order: [['seq', 'desc']], limit: 100 }));
const head = store.headSeq();
timeit('changesSince(head - 1000) on one session topic', 200, () => store.changesSince(head - 1000, [`session:${sid(3)}`]));
timeit('get one session', 2000, () => store.get(session, sid(4321)));

const size = fs.statSync(path.join(home, 'wisp.db')).size;
log(`  db size: ${(size / 1e6).toFixed(0)} MB, change rows: ${store.headSeq().toLocaleString('en')}`);
const pass = listAll <= 5 && bulkRate >= 20_000 && streamRate >= 20_000;
log(`G1 ${pass ? 'PASS' : 'FAIL'}: list p95 ${listAll.toFixed(2)} ms (all columns ${listFull.toFixed(2)} ms, first 200 ${listPage.toFixed(2)} ms) ≤ 5 ms, append ${bulkRate.toFixed(0)} / ${streamRate.toFixed(0)} ev/s ≥ 20,000`);
store.close();
if (!process.argv.includes('--keep')) fs.rmSync(home, { recursive: true, force: true });
else log(`  kept ${home}`);
process.exitCode = pass ? 0 : 1;
