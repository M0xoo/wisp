// Gate G3 (plan §9.1): topic SSE fan-out. 4 clients, 10 running tasks streaming.
//   pass: bytes sent ≥ 5× fewer than v1, CPU ≤ v1's
//   run:  node spikes/sync-bench/g3.ts [--seconds=120] [--seed=1]
//
// v1 (server/http/respond.js eventStream, server/index.js): every client gets every frame. Per harness
// event the runner broadcasts `activity` {sessionId, turnId, item}; a tool call also #touch-es the
// session, which broadcasts its whole `summary` row (runner.js summarize); a text step is a quiet
// touch (no summary); a tool's output re-broadcasts its activity item with the output. Plus `ping`
// every 25 s. v2: the same events become change rows (an event upsert or patch on session:<id>, a
// patch of the session's list row), fed to @wisp/sync; each client holds `list` and one open task.

import { performance } from 'node:perf_hooks';
import { diff } from '@wisp/protocol';
import type { PatchOp, Topic } from '@wisp/protocol';
import { SyncServer } from '@wisp/sync';
import type { ChangeRow, ServerOutput } from '@wisp/sync';

const arg = (name: string, def: number): number => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const SECONDS = arg('seconds', 120);
const CLIENTS = 4;
const TASKS = 10;

let seed = arg('seed', 1);
const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const words = (n: number): string => Array.from({ length: n }, () => ['the', 'test', 'file', 'runs', 'build', 'server', 'fix', 'check', 'route'][Math.floor(rand() * 9)]).join(' ');

/** A summary row as v1's summarize() returns it for a running task in a project, with a PR. */
function summary(i: number, t: number, live: string): Record<string, unknown> {
  return {
    id: `s-${i}-0193c2a4-7b1e-7c3d-9f2a`, title: `Fix the flaky upload test in the API ${i}`, agent: 'claude', cwd: `/Users/me/code/api-${i}`,
    project: `api-${i}`, projectId: `p${i}`, color: 'violet', mode: 'auto', model: 'opus', effort: 'high', state: 'running', unread: false, archived: false,
    createdAt: 1730900000000 + i, updatedAt: t, turnCount: 3, queued: 0, later: [], status: 'running', preview: 'Tests pass; the upload retries now back off.',
    live, asks: false, question: '', approval: false, branch: `wisp/fix-upload-${i}`, keepWorktree: false, foreign: '',
    toShip: { dirty: 2, ahead: 1, unpushed: 1 }, shipping: null, pr: { number: 700 + i, url: `https://github.com/acme/api/pull/${700 + i}`, state: 'open', draft: false, review: null, checks: 'pending', conflict: false },
    conflictFix: null, review: null, groupId: null, origin: null, usage: { input: 182_000 + t % 1000, output: 9100, cost: 1.92 }, plan: { session5h: 0.21, weekly: 0.04 },
  };
}

type Ev = { at: number; task: number; kind: 'tool' | 'output' | 'text'; n: number; item: Record<string, unknown>; output: string };

const item = (e: Pick<Ev, 'at' | 'task' | 'kind' | 'n'>): Record<string, unknown> =>
  e.kind === 'text' ? { t: e.at, kind: 'text', label: words(40) } : { t: e.at, kind: 'run', label: `Running ${words(3)}`, detail: `npm test -- ${words(2)}`, call: `toolu_${e.task}_${e.n}` };
const output = (): string => Array.from({ length: 12 }, () => words(10)).join('\n');

/** Each task: a tool call every ~1.5 s, its output ~0.8 s later, a text step every ~4 s. */
function workload(): Ev[] {
  const evs: Ev[] = [];
  for (let task = 0; task < TASKS; task++) {
    let n = 0;
    for (let t = rand() * 1000; t < SECONDS * 1000; t += 800 + rand() * 1400) {
      const tool = { at: Math.floor(t), task, kind: 'tool' as const, n: ++n, output: '' };
      evs.push({ ...tool, item: item(tool) }, { at: Math.floor(t + 300 + rand() * 1000), task, kind: 'output', n, item: {}, output: output() });
      if (rand() < 0.35) {
        const text = { at: Math.floor(t + 100), task, kind: 'text' as const, n: ++n, output: '' };
        evs.push({ ...text, item: item(text) });
      }
    }
  }
  return evs.sort((a, b) => a.at - b.at);
}

function v1(evs: Ev[]): { bytes: number; frames: number; cpuMs: number } {
  const clients: string[][] = Array.from({ length: CLIENTS }, () => []);
  let bytes = 0;
  let frames = 0;
  const items = new Map<string, Record<string, unknown>>();
  const cpu = performance.now();
  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      c.push(frame);
      if (c.length > 256) c.length = 0; // a socket write: kept from growing in the bench
      bytes += frame.length;
      frames++;
    }
  };
  let nextPing = 25_000;
  for (const e of evs) {
    for (; nextPing <= e.at; nextPing += 25_000) broadcast('ping', {});
    const key = `${e.task}:${e.n}`;
    if (e.kind === 'output') {
      const it = items.get(key);
      if (it === undefined) continue;
      it['output'] = e.output;
      it['outAt'] = e.at;
      broadcast('activity', { sessionId: `s-${e.task}`, turnId: `t-${e.task}`, item: it, update: true });
      continue;
    }
    const it = { ...e.item };
    items.set(key, it);
    broadcast('activity', { sessionId: `s-${e.task}`, turnId: `t-${e.task}`, item: it });
    if (e.kind === 'tool') broadcast('summary', summary(e.task, e.at, String(it['label'])));
  }
  return { bytes, frames, cpuMs: performance.now() - cpu };
}

type Batch = { at: number; rows: Omit<ChangeRow, 'seq' | 'at'>[] };

/** What the store writes for the events (its work, done before timing): an event row, the list row's patch. */
function changeRows(evs: Ev[]): { batches: Batch[]; list: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < TASKS; i++) rows.set(`s-${i}`, summary(i, 0, 'Starting up'));
  const start = new Map(rows);
  const batches: Batch[] = [];
  for (const e of evs) {
    const topic: Topic = `session:s-${e.task}`;
    const key = `${e.task}:${e.n}`;
    if (e.kind === 'output') {
      batches.push({ at: e.at, rows: [{ topic, entity: 'event', id: key, op: 'patch', patch: [{ op: 'add', path: '/output', value: e.output }, { op: 'add', path: '/outAt', value: e.at }] }] });
      continue;
    }
    const id = `s-${e.task}`;
    const prev = rows.get(id) as Record<string, unknown>; // every task has a row
    const next = { ...prev, updatedAt: e.at, ...(e.kind === 'tool' && { live: String(e.item['label']) }) };
    rows.set(id, next);
    const ops: PatchOp[] = diff(prev, next);
    batches.push({ at: e.at, rows: [{ topic, entity: 'event', id: key, op: 'upsert', patch: e.item }, ...(ops.length > 0 ? [{ topic: 'list' as const, entity: 'session', id, op: 'patch' as const, patch: ops }] : [])] });
  }
  return { batches, list: start };
}

function v2(evs: Ev[], open: (client: number) => Topic[]): { bytes: number; frames: number; cpuMs: number; changes: number } {
  const { batches, list } = changeRows(evs);
  const server = new SyncServer<number>({ epoch: 'E', peer: { peer: 'p', name: 'p', build: 'b', version: '2', proto_min: 2, proto_max: 2, plugins: [] }, headSeq: 0, oldestSeq: 0, canRead: () => true });
  let bytes = 0;
  let frames = 0;
  let seq = 0;
  let changes = 0;
  let now = 0;
  const carry = (outs: ServerOutput<number>[]): void => {
    for (const o of outs) {
      if (o.kind === 'send') {
        bytes += o.frame.length;
        frames += o.id === null ? 0 : 1;
        carry(server.handle({ kind: 'drained', conn: o.conn, bufferedBytes: 0 }, now));
      } else if (o.kind === 'snapshotRequest') {
        const snap = o.topic === 'list' ? [...list].map(([id, v]) => ({ e: 'session', id, v })) : [];
        carry(server.handle({ kind: 'snapshotRows', conn: o.conn, topic: o.topic, req: o.req, seq, rows: snap, full: true }, now));
      }
    }
  };
  for (let c = 0; c < CLIENTS; c++) carry(server.handle({ kind: 'connect', conn: `c${c}`, caller: c, query: { client_id: `c${c}`, fresh: open(c).join(',') } }, now));
  const bytesAtStart = bytes; // the first snapshots: v1 has its GET /api/sessions for that
  const cpu = performance.now();
  let tick = 50;
  for (const b of batches) {
    for (; tick <= b.at; tick += 50) {
      now = tick;
      carry(server.handle({ kind: 'tick' }, now));
    }
    now = b.at;
    const rows = b.rows.map((x) => ({ ...x, seq: ++seq, at: now }));
    changes += rows.length;
    carry(server.handle({ kind: 'committed', rows }, now));
  }
  for (; tick <= SECONDS * 1000 + 100; tick += 50) {
    now = tick;
    carry(server.handle({ kind: 'tick' }, now));
  }
  return { bytes: bytes - bytesAtStart, frames, cpuMs: performance.now() - cpu, changes };
}

const evs = workload();
const a = v1(evs);
const listOnly = v2(evs, () => ['list']);
const oneOpen = v2(evs, (c) => ['list', `session:s-${c}`]);
const mb = (n: number): string => `${(n / 1e6).toFixed(2)} MB`;
console.log(`G3: ${CLIENTS} clients, ${TASKS} running tasks, ${SECONDS} s, ${evs.length} harness events (summary row ${JSON.stringify(summary(0, 0, 'x')).length} B)`);
console.log(`v1 broadcast            ${mb(a.bytes).padStart(9)}  ${String(a.frames).padStart(6)} frames  cpu ${a.cpuMs.toFixed(0)} ms`);
for (const [name, r] of [['v2 list only', listOnly], ['v2 list + 1 open task', oneOpen]] as const) {
  console.log(`${name.padEnd(23)} ${mb(r.bytes).padStart(9)}  ${String(r.frames).padStart(6)} frames  cpu ${r.cpuMs.toFixed(0)} ms  ${(a.bytes / r.bytes).toFixed(1)}× fewer bytes  (${r.changes} change rows)`);
}
const pass = a.bytes / oneOpen.bytes >= 5;
console.log(pass ? 'PASS: ≥ 5× fewer bytes with a task open on every client' : 'FAIL: under 5×');
console.log('cpu: fan-out only (v1: stringify + 4 writes per broadcast, without summarize(); v2: SyncServer.handle + framing)');
process.exitCode = pass ? 0 : 1;
